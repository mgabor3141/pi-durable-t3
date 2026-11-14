// The file calls on the wire, against a real host: T3's typed errors (never a defect), environment-wide reads,
// writes limited to a registered root, and T3's scope split — a client granted `filesystem:read` only reads; one
// granted `filesystem:write` too edits.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthAccessReadScope, AuthFilesystemReadScope, AuthFilesystemWriteScope, AuthOrchestrationOperateScope, AuthOrchestrationReadScope, AuthTerminalOperateScope } from "@t3tools/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, postJson, waitListening, wsTicket } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir, seedProjects } from "./host-process-harness.ts";

const PORT = 5141;
let root: string;
let project: string;
let host: Launched | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-files-ws-"));
	project = join(root, "projects", "alpha");
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(join(project, "src", "main.ts"), "export const needle = 1;\n");
	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await seedProjects(root, [{ id: "p-alpha", title: "alpha", path: project }]);
	host = launch(root, PORT, {}, join(root, "agent"));
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

/** A client holding exactly `scopes`, minted by the full-scope client and exchanged like a device pairing. */
async function narrowToken(fullToken: string, scopes: string[]): Promise<string> {
	const minted = await postJson(PORT, "/api/auth/pairing-token", { scopes }, { authorization: `Bearer ${fullToken}` });
	expect(minted.status).toBe(200);
	return pair(PORT, String(minted.body["credential"]));
}

it("serves the file panel's calls to a full-scope client, with typed refusals", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const full = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, full);
	try {
		const listed = exitValue(await ws.call("projects.listEntries", { cwd: project, directoryPath: "" }), "listEntries") as { entries: { path: string; kind: string }[] };
		expect(listed.entries).toEqual([{ path: "src", kind: "directory" }]);

		const read = exitValue(await ws.call("projects.readFile", { cwd: project, relativePath: "src/main.ts" }), "readFile") as { contents: string };
		expect(read.contents).toBe("export const needle = 1;\n");

		expect(exitValue(await ws.call("projects.writeFile", { cwd: project, relativePath: "src/main.ts", contents: "export const needle = 2;\n" }), "writeFile")).toEqual({ relativePath: "src/main.ts" });
		expect(await readFile(join(project, "src", "main.ts"), "utf8")).toBe("export const needle = 2;\n");

		const found = exitValue(await ws.call("projects.searchEntries", { cwd: project, query: "main", limit: 10 }), "searchEntries") as { entries: { path: string }[] };
		expect(found.entries.map((entry) => entry.path)).toContain("src/main.ts");
		const contents = exitValue(await ws.call("projects.searchContents", { cwd: project, query: "needle = 2", limit: 10, caseSensitive: false, wholeWord: false, useRegex: false }), "searchContents") as { matches: { path: string; lineNumber: number }[] };
		expect(contents.matches).toMatchObject([{ path: "src/main.ts", lineNumber: 1 }]);

		// Refusals are the contract's own tagged errors (exitError throws on a defect).
		expect(exitError(await ws.call("projects.readFile", { cwd: project, relativePath: "../../../etc/passwd" }), "read ..")).toMatchObject({ _tag: "ProjectReadFileError", failure: "workspace_path_outside_root" });
		expect((exitValue(await ws.call("projects.readFile", { cwd: project, relativePath: join(root, "config.toml") }), "read absolute") as { contents: string }).contents).toContain("listen");
		const outsideRead = exitValue(await ws.call("projects.readFile", { cwd: root, relativePath: "config.toml" }), "read outside cwd") as { contents: string };
		expect(outsideRead.contents).toContain("listen");
		expect(exitError(await ws.call("projects.writeFile", { cwd: "/tmp", relativePath: "x", contents: "x" }), "write unknown root")).toMatchObject({ _tag: "ProjectWriteFileError", failure: "workspace_path_outside_root" });
		expect(exitValue(await ws.call("projects.listEntries", { cwd: root, directoryPath: "" }), "list outside project")).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ path: "config.toml", kind: "file" })]) });
		expect(exitValue(await ws.call("projects.searchEntries", { cwd: root, query: "config", limit: 5 }), "search outside project")).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ path: "config.toml", kind: "file" })]) });
		expect(exitValue(await ws.call("projects.searchContents", { cwd: root, query: "listen", limit: 5, caseSensitive: false, wholeWord: false, useRegex: false }), "contents outside project")).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ path: "config.toml", lineNumber: 1 })]) });
		expect(exitError(await ws.call("projects.readFile", { cwd: project, relativePath: "missing.txt" }), "read missing")).toMatchObject({ _tag: "ProjectReadFileError", failure: "operation_failed" });
	} finally {
		ws.close();
	}
}, 60_000);

it("a client that asks for frame parts gets a large answer in parts that join back whole (T3 0.1.9)", async () => {
	const big = "é".repeat(120_000); // 240 KB on the wire: several 48 KiB parts.
	await writeFile(join(project, "big.txt"), big);
	const token = await pair(PORT, pairCode(root));
	const read = async (query: string): Promise<{ raw: string[]; contents: string }> => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(await wsTicket(PORT, token))}${query}`);
		const raw: string[] = [];
		try {
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve());
				ws.addEventListener("error", () => reject(new Error("websocket connect failed")));
			});
			const answered = new Promise<string>((resolve) => {
				let pending = "";
				ws.addEventListener("message", (event) => {
					const frame = String(event.data);
					raw.push(frame);
					// T3's `joinSocketFrameParts`: a record separator marks every part but the last.
					if (frame.startsWith("\u001e")) pending += frame.slice(1);
					else if (`${pending}${frame}`.includes('"Exit"')) resolve(`${pending}${frame}`);
				});
			});
			ws.send(JSON.stringify({ _tag: "Request", id: 1, tag: "projects.readFile", payload: { cwd: project, relativePath: "big.txt" }, headers: [] }));
			const exit = JSON.parse(await answered) as { exit: { value: { contents: string } } };
			return { raw, contents: exit.exit.value.contents };
		} finally {
			ws.close();
		}
	};
	const parts = await read("&frameParts=1");
	expect(parts.contents).toBe(big);
	expect(parts.raw.length, "more than one frame").toBeGreaterThan(3);
	expect(parts.raw.slice(0, -1).every((frame) => frame.startsWith("\u001e") && Buffer.byteLength(frame) <= 48 * 1024)).toBe(true);
	// A client that does not ask gets the answer whole, as before.
	const whole = await read("");
	expect(whole.contents).toBe(big);
	expect(whole.raw).toHaveLength(1);
});

it("splits read from write by the session's scopes, as T3's RPC authorization does", async () => {
	const full = await pair(PORT, pairCode(root));
	const readOnly = await narrowToken(full, [AuthFilesystemReadScope]);
	const ws = await connectWs(PORT, readOnly);
	try {
		expect((exitValue(await ws.call("projects.readFile", { cwd: project, relativePath: "src/main.ts" }), "read as reader") as { contents: string }).contents).toContain("needle");
		const refused = exitError(await ws.call("projects.writeFile", { cwd: project, relativePath: "src/main.ts", contents: "pwned" }), "write as reader");
		expect(refused).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: AuthFilesystemWriteScope });
		expect(await readFile(join(project, "src", "main.ts"), "utf8")).toContain("needle = 2");
	} finally {
		ws.close();
	}

	const writer = await narrowToken(full, [AuthFilesystemReadScope, AuthFilesystemWriteScope]);
	const ws2 = await connectWs(PORT, writer);
	try {
		exitValue(await ws2.call("projects.writeFile", { cwd: project, relativePath: "src/main.ts", contents: "by writer\n" }), "write as writer");
		expect(await readFile(join(project, "src", "main.ts"), "utf8")).toBe("by writer\n");
	} finally {
		ws2.close();
	}

	// A client with neither scope cannot even read.
	const nothing = await narrowToken(full, [AuthAccessReadScope]);
	const ws3 = await connectWs(PORT, nothing);
	try {
		expect(exitError(await ws3.call("projects.readFile", { cwd: project, relativePath: "src/main.ts" }), "read as nobody")).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: AuthFilesystemReadScope });
		expect(exitError(await ws3.call("projects.listEntries", { cwd: project, directoryPath: "" }), "list as nobody")).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
	} finally {
		ws3.close();
	}
}, 60_000);

it("every method is gated by T3's scope table, before the handler or the refusal of an unsupported call", async () => {
	const full = await pair(PORT, pairCode(root));
	const reader = await narrowToken(full, [AuthOrchestrationReadScope]);
	const ws = await connectWs(PORT, reader);
	try {
		exitValue(await ws.call("server.probe", {}), "probe as reader");
		const dispatch = { type: "thread.create", commandId: "c-scope", threadId: "t-scope", projectId: "p-alpha", title: "x", modelSelection: { instanceId: "pi", model: "default" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" };
		expect(exitError(await ws.call("orchestration.dispatchCommand", dispatch), "dispatch as reader")).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: AuthOrchestrationOperateScope });
		expect(exitError(await ws.call("subscribeAuthAccess", {}), "access stream as reader")).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: AuthAccessReadScope });
		// A method this host refuses anyway is still answered by the scope check first, as T3 answers it.
		expect(exitError(await ws.call("terminal.open", { threadId: "t", terminalId: "x", cwd: project }), "terminal as reader")).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: AuthTerminalOperateScope });
	} finally {
		ws.close();
	}
}, 60_000);
