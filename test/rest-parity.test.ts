// The REST parity route validates, and the rate limiter ignores a client-supplied header
// (review wire M6, sec F7, conc F4).
//
// `/api/projects/mutate` is the documented HTTP twin of the `projects.mutate` RPC. The RPC payload is decoded by the
// contract's `ProjectMutation` schema, so a malformed command is refused at the boundary; the REST route read
// `request.json` and handed the result to the bridge as-is. Two consequences, both probes below:
//
//   - a body the RPC would refuse reached the bridge. `{}` reached `mutateProject`'s switch, matched no case, and the
//     route answered 200 with no body — a client that asked to create a project was told it succeeded, and nothing
//     happened. A `projectId` outside the contract's brand (the RPC's `ProjectId`) took a bridge-minted id, so the
//     same JSON over WS and over REST created two different projects.
//   - the pairing rate limiter keyed its bucket on `x-forwarded-for` whenever the socket was loopback, which is every
//     request on the default bind. A caller picks one fresh bucket per attempt by setting a header, and is never
//     limited: 10 000 guesses at a pairing code, 10 000 fresh counters.
//
// The probes drive a real child host over HTTP.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { getJson, pair, postJson, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-rest-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-rest-0123456789abcdef";

async function start(name: string, port: number) {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [], defaults: {} }), "utf8");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind ${port}: ${host.out()}`);
	const token = await pair(port, TOKEN);
	return { root, host, token };
}

const mutate = (port: number, token: string, body: unknown) => postJson(port, "/api/projects/mutate", body, { authorization: `Bearer ${token}` });

/** A POST of a form body (the pairing exchange), returning status and parsed body. */
async function formPost(port: number, path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(8000),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* a non-JSON answer is reported by status + text */
	}
	return { status: response.status, body };
}

const exchangeForm = (subject: string) => ({
	grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
	subject_token: subject,
	subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
	requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
});

it("the REST mutate route answers the contract's schema, not the bridge's switch (wire M6)", async () => {
	const { host, root } = await start("rest", 4937);
	try {
		const token = (await pair(4937, TOKEN)) ?? "";
		const uuid = "7d1c93a4-5b1f-4e3a-9c2d-0a1b2c3d4e5f";
		const target = join(root, "projects", "rest-create");

		// (1) An empty object is not a project mutation. Pre-fix the route's switch matched no case, the bridge returned
		// `undefined`, and the client got 200 with an empty body: a create that did nothing, reported as success.
		const empty = await mutate(4937, token, {});
		expect(empty.status, `an empty body is a 400: ${JSON.stringify(empty)}`).toBe(400);
		expect(empty.body._tag).toBe("ProjectMutationError");
		expect(existsSync(target), "nothing was created").toBe(false);

		// (2) Fields the contract requires, with the shape it requires. These are the RPC's refusals; passed through, the
		// bridge read `mutation.commandId` as `undefined` — every such mutation sharing ONE receipt bucket — and a numeric
		// title reached the registry as a project name.
		const root1 = join(root, "projects/shapes");
		await mkdir(root1, { recursive: true });
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["a missing commandId", { type: "project.create", projectId: uuid, title: "T", workspaceRoot: root1 }, "commandId"],
			["a missing projectId", { type: "project.create", commandId: "c-2", title: "T", workspaceRoot: root1 }, "projectId"],
			["a numeric title", { type: "project.create", commandId: "c-3", projectId: uuid, title: 42, workspaceRoot: root1 }, "title"],
			["a numeric workspaceRoot", { type: "project.create", commandId: "c-4", projectId: uuid, title: "T", workspaceRoot: 7 }, "workspaceRoot"],
			["a non-boolean force", { type: "project.delete", commandId: "c-5", projectId: uuid, force: "yes" }, "force"],
		];
		for (const [what, body, names] of cases) {
			const refused = await mutate(4937, token, body);
			expect(refused.status, `${what} is a 400: ${JSON.stringify(refused)}`).toBe(400);
			expect(refused.body._tag, what).toBe("ProjectMutationError");
			expect(String(refused.body.message), `${what}: the refusal names the field`).toContain(names);
		}

		// (3) A create's title must be non-empty (the contract's TrimmedNonEmptyString).
		const emptyTitle = await mutate(4937, token, { type: "project.create", commandId: "c-empty-title", projectId: uuid, title: "   ", workspaceRoot: join(root, "projects/t") });
		expect(emptyTitle.status, `an empty title is a 400: ${JSON.stringify(emptyTitle)}`).toBe(400);

		// (4) A `type` the contract has no variant for is refused.
		const badType = await mutate(4937, token, { type: "project.teleport", commandId: "c-bad-type", projectId: uuid });
		expect(badType.status, `an unknown mutation type is a 400: ${JSON.stringify(badType)}`).toBe(400);

		// (5) The valid command still works: 200, the T3 Project shape, and the mutation reached the registry.
		const good = await mutate(4937, token, { type: "project.create", commandId: "c-good", projectId: uuid, title: "Rest", workspaceRoot: target, createWorkspaceRootIfMissing: true });
		expect(good.status, `the valid mutation succeeds: ${JSON.stringify(good)}`).toBe(200);
		expect(good.body).toMatchObject({ id: uuid, title: "Rest", workspaceRoot: target });
		const listed = await getJson(4937, "/api/projects", { authorization: `Bearer ${token}` });
		const shell = listed.body as unknown as { projects: { id: string; title: string }[] };
		expect(shell.projects.map((project) => project.title)).toContain("Rest");

		// (6) A refusal names what is wrong, in the contract's error shape, and carries the commandId back.
		expect(empty.body).toMatchObject({ _tag: "ProjectMutationError", commandId: "" });
		expect(String(empty.body.message).length, "the refusal explains itself").toBeGreaterThan(20);

		// (7) A duplicate path is still the 409 conflict, not a 400: validation did not swallow the typed refusals.
		const again = await mutate(4937, token, { type: "project.create", commandId: "c-dup", projectId: "11111111-1111-4111-8111-111111111111", title: "Dup", workspaceRoot: target, createWorkspaceRootIfMissing: true });
		expect(again.status, `the duplicate path is a conflict: ${JSON.stringify(again)}`).toBe(409);
		expect(again.body._tag).toBe("ProjectMutationError");

		// (8) Nothing the schema refused left a trace: the registry holds exactly the one project the valid command made.
		const after = await getJson(4937, "/api/projects", { authorization: `Bearer ${token}` });
		const projects = (after.body as unknown as { projects: { title: string }[] }).projects;
		expect(projects.map((project) => project.title).sort(), `only the valid mutation created anything: ${JSON.stringify(projects)}`).toEqual(["Rest"]);
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 90_000);

it("rotating x-forwarded-for does not mint a fresh rate-limit bucket (sec F7, conc F4)", async () => {
	const { host } = await start("limit", 4938);
	try {
		// Every attempt comes from loopback with a DIFFERENT x-forwarded-for. Keyed on the header, each is its own
		// bucket and the limiter never fires; keyed on the socket, the failures accumulate and the caller is blocked.
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 30; attempt++) {
			const response = await formPost(4938, "/oauth/token", exchangeForm(`guessed-code-${attempt}`), { "x-forwarded-for": `203.0.113.${attempt}` });
			statuses.push(response.status);
			if (response.status === 429) break;
		}
		const limited = statuses.filter((status) => status === 429).length;
		expect(limited, `a caller cannot buy unlimited attempts with a header (statuses: ${statuses.join(",")})`).toBeGreaterThan(0);
		// The block is per socket address, and the limiter's own limit is 10/minute: it fires by the 11th failure.
		expect(statuses.length, `the limiter fired at attempt ${statuses.length}, not after 30 guesses`).toBeLessThanOrEqual(12);
		// The block is not global: it is the address that guessed. A correct code from the same socket is now blocked
		// too — that is what a rate limit is — so check the shape of the answer, and that pairing works on a fresh host.
		const blocked = await formPost(4938, "/oauth/token", exchangeForm(TOKEN), { "x-forwarded-for": "203.0.113.200" });
		expect(blocked.status, `the blocked socket is answered with a rate limit: ${JSON.stringify(blocked)}`).toBe(429);
		expect(blocked.body.code).toBe("rate_limited");
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 90_000);
