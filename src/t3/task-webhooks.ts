// T3's webhook triggers for scheduled tasks (ScheduledTaskService's `triggerWebhook`, webhookRoute, webhookDedupe,
// webhookVerification), on this host: a task with a `webhook` schedule has a URL (`/api/hooks/<task id>/<token>`), and
// each request to it that passes the task's checks runs the task once, its prompt rendered from the request
// (`{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`, `{{request}}`; T3's template, vendored, which
// frames request text as untrusted). The checks, in T3's order: the URL's token, a rate limit, the task enabled, an
// HMAC-SHA256 signature over the raw body, the filters, a replay key, a coalescing window.
//
// What T3 has and this host does not: its relay (T3 Connect), which holds requests for a machine that is offline and
// gives them a delivery id and a receive time. Every request here arrives directly, now, so `maxDeliveryAgeMinutes`
// is stored and never skips one.
//
// One document a task (`pi-durable-t3.scheduled-task-webhook`): its token and signing secret, its last deliveries,
// its replay keys and the windows still open.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, type ScheduledTask, type ScheduledTaskWebhookDelivery, type ScheduledTaskWebhookDeliverySummary, type ScheduledTaskWebhookSignature } from "@t3tools/contracts";
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "@t3tools/t3-server/webhookFilter";
import { redactHeaders, redactQuery, renderWebhookPrompt, type WebhookRequest } from "@t3tools/t3-server/webhookTemplate";
import type { Logger } from "./logging.ts";

type Task = typeof ScheduledTask.Type;
type Delivery = typeof ScheduledTaskWebhookDelivery.Type;
type DeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

/** T3's route prefix and limits (ScheduledTaskService, webhookRoute). */
export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const DELIVERY_RETENTION = 50;
const DEDUPE_DELIVERY_RETENTION = 20;
const FILTERED_DELIVERY_RETENTION = 20;
const QUIET_LOG_PER_MINUTE = 10;
const LOG_BODY_LIMIT = 64 * 1024;
const LOG_PROMPT_LIMIT = 64 * 1024;
const MAX_QUEUED_PER_TASK = 20;
const RATE_LIMIT_PER_MINUTE = 60;
const REPLAY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COALESCE_WINDOW_SECONDS = 120;
const PROMPT_TOO_LONG = `The rendered prompt is over ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`;

/** A request to a hook, as the route read it. */
export interface WebhookTriggerRequest extends WebhookRequest {
	readonly hookId: string;
	readonly token: string;
	readonly body: Uint8Array;
}

/** What the route answers (T3's `WebhookTriggerResult`). */
export type WebhookTriggerResult =
	| { readonly _tag: "accepted"; readonly deliveryId: string; readonly outcome: "accepted" | "duplicate" | "coalesced" | "filtered" | "prompt_too_long" }
	| { readonly _tag: "not_found" }
	| { readonly _tag: "rejected_signature" }
	| { readonly _tag: "disabled" }
	| { readonly _tag: "rate_limited"; readonly outcome: "rate_limited" | "queue_full" };

type StoredRequest = { method: string; path: string; query: string; headers: Record<string, string>; bodyText: string };
/** A coalescing window that is still open: the run it will make, from the last request that joined it. */
type Pending = { deliveryId: string; coalesceKey: string; dueAt: number; request: StoredRequest };
type Hook = {
	/** The task's `createdAt`: a task deleted and made again under the same id starts over. */
	taskCreatedAt: string;
	token: string;
	secret: string | null;
	deliveries: Delivery[];
	replayKeys: { key: string; deliveryId: string; expiresAt: number }[];
	pending: Pending[];
};

const HookDoc = defineDocFamily<{ hook: JsonValue | null }, { hook: JsonValue | null }>({
	kind: "pi-durable-t3.scheduled-task-webhook",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** T3's `verifyWebhookSignature`: HMAC-SHA256 over the raw body, compared in constant time. */
function verifyWebhookSignature(input: { readonly signature: ScheduledTaskWebhookSignature; readonly secret: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }): boolean {
	const received = input.headers[input.signature.header.toLowerCase()];
	if (received === undefined) return false;
	const value = received.trim();
	const prefix = input.signature.prefix;
	if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
	const candidate = value.slice(prefix.length);
	const valid = input.signature.encoding === "hex" ? /^(?:[0-9a-fA-F]{2})+$/.test(candidate) : /^[A-Za-z0-9+/]+={0,2}$/.test(candidate);
	if (!valid) return false;
	const tag = Buffer.from(input.signature.encoding === "hex" ? candidate.toLowerCase() : candidate, input.signature.encoding);
	const expected = createHmac("sha256", input.secret).update(input.body).digest();
	return tag.byteLength === expected.byteLength && timingSafeEqual(tag, expected);
}

/** Hashes compared, so the comparison leaks neither string's length (T3's `constantTimeEquals`). */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** T3's dedupe key: the template rendered from the request, hashed; none when a placeholder is missing. */
function dedupeKey(template: string | undefined, request: WebhookRequest): string {
	if (template === undefined) return "";
	const rendered = renderWebhookPrompt(template, request, "", true);
	return rendered.missing.length > 0 || rendered.prompt === "" ? "" : createHash("sha256").update(rendered.prompt).digest("hex");
}

type RateWindow = { taken: { at: number }[]; refusalLogged: boolean };

export class TaskWebhooks {
	readonly #harness: Harness;
	readonly #now: () => Date;
	readonly #log: Logger | undefined;
	readonly #origin: () => string | undefined;
	readonly #hooks = new Map<string, Hook>();
	/** Requests checked a minute (valid ones give their slot back), and runs started a minute, by task. */
	readonly #checked = new Map<string, RateWindow>();
	readonly #started = new Map<string, RateWindow>();
	/** When the quiet outcomes (filtered, duplicate, coalesced) were last logged, by task and kind. */
	readonly #quietLogs = new Map<string, number[]>();
	/** Runs asked for and not yet started, by task. */
	readonly #queued = new Map<string, number>();
	/** One write at a time a task: each rewrites the task's document. */
	readonly #writes = new Map<string, Promise<void>>();

	constructor(options: { harness: Harness; now: () => Date; log?: Logger | undefined; origin?: (() => string | undefined) | undefined }) {
		this.#harness = options.harness;
		this.#now = options.now;
		this.#log = options.log;
		this.#origin = options.origin ?? (() => undefined);
	}

	/** Read the hooks of these tasks, once at start. */
	async load(taskIds: readonly string[]): Promise<void> {
		for (const taskId of taskIds) {
			const stored = await this.#harness.snapshot(HookDoc, taskId, BACKGROUND_CONTEXT);
			if (stored?.hook != null) this.#hooks.set(taskId, stored.hook as unknown as Hook);
		}
	}

	/** T3's `webhookEndpoint`: the task's URL path, the whole URL when this host knows where it is reached, and whether
	 * a signing secret is stored. */
	endpoint(task: Pick<Task, "id" | "schedule">): Task["webhook"] {
		const hook = this.#hooks.get(task.id);
		if (task.schedule.type !== "webhook" || hook === undefined) return undefined;
		const path = `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(task.id)}/${hook.token}`;
		const origin = this.#origin()?.replace(/\/+$/, "");
		return { path, url: origin === undefined || origin === "" ? null : `${origin}${path}`, hasSecret: hook.secret !== null } as Task["webhook"];
	}

	/**
	 * A task is saved with a webhook schedule: it keeps its token, or gets one, and its signing secret follows T3's
	 * rule (a secret given replaces the stored one; none given keeps it; no signature check stores none). Throws
	 * T3's refusal for a signature check with no secret.
	 */
	async save(task: Pick<Task, "id" | "createdAt">, signature: { readonly secret?: string | undefined } | null | undefined): Promise<void> {
		const existing = this.#hooks.get(task.id);
		const kept = existing !== undefined && existing.taskCreatedAt === task.createdAt ? existing : undefined;
		const secret = signature == null ? null : (signature.secret ?? kept?.secret ?? null);
		if (signature != null && secret === null) throw new Error("A webhook signature check needs a signing secret.");
		await this.#put(task.id, { taskCreatedAt: task.createdAt, token: kept?.token ?? newToken(), secret, deliveries: kept?.deliveries ?? [], replayKeys: kept?.replayKeys ?? [], pending: kept?.pending ?? [] });
	}

	/** T3's `rotateWebhookToken`: a new URL; the old one answers as an unknown hook. */
	async rotate(taskId: string): Promise<void> {
		const hook = this.#hooks.get(taskId);
		if (hook === undefined) throw new Error("Only webhook tasks have a URL token.");
		await this.#put(taskId, { ...hook, token: newToken() });
	}

	/** The task is gone, or no longer a webhook task: its URL, secret, deliveries and open windows go with it. */
	async remove(taskId: string): Promise<void> {
		if (!this.#hooks.has(taskId)) return;
		this.#checked.delete(taskId);
		this.#started.delete(taskId);
		this.#queued.delete(taskId);
		await this.#put(taskId, undefined);
	}

	/** T3's delivery list: newest first, without the request. */
	deliveries(taskId: string): DeliverySummary[] {
		return (this.#hooks.get(taskId)?.deliveries ?? []).toReversed().map(({ query: _query, headers: _headers, body: _body, bodyTruncated: _truncated, renderedPrompt: _prompt, ...summary }) => summary as DeliverySummary);
	}

	delivery(taskId: string, deliveryId: string): Delivery | undefined {
		return this.#hooks.get(taskId)?.deliveries.find((delivery) => delivery.id === deliveryId);
	}

	/**
	 * One request to a task's URL (T3's `triggerWebhook`). `run` starts the task with the rendered prompt and resolves
	 * when the run was dispatched; it is not awaited here, as T3 answers 202 once a delivery is accepted.
	 */
	async trigger(task: Task | undefined, request: WebhookTriggerRequest, run: (task: Task, deliveryId: string, prompt: string) => Promise<void>): Promise<WebhookTriggerResult> {
		const hook = task === undefined ? undefined : this.#hooks.get(task.id);
		// A wrong token is indistinguishable from an unknown hook, so the URL does not reveal which hooks exist.
		if (task === undefined || hook === undefined || task.schedule.type !== "webhook" || !sameSecret(request.token, hook.token)) return { _tag: "not_found" };
		const schedule = task.schedule;
		const now = this.#now().getTime();
		const deliveryId = `delivery:${randomUUID()}`;
		const signed = schedule.signature !== null;
		const log = (outcome: DeliverySummary["outcome"], details: { signatureVerified?: boolean; missing?: readonly string[]; renderedPrompt?: string; error?: string; pendingWindow?: boolean } = {}) =>
			this.#record(task.id, deliveryRecord(deliveryId, task.id, now, request, outcome, details));

		// Floods are refused before any signature work or log write; a valid delivery gives this slot back.
		const slot = { at: now };
		const checked = takeSlot(this.#checked, task.id, now, slot);
		if (checked !== "allowed") {
			if (checked === "first_refused") await log("rate_limited");
			return { _tag: "rate_limited", outcome: "rate_limited" };
		}
		const giveBack = () => {
			const window = this.#checked.get(task.id);
			if (window !== undefined) window.taken = window.taken.filter((entry) => entry !== slot);
		};
		if (!task.enabled) {
			await log("disabled");
			return { _tag: "disabled" };
		}
		if (schedule.signature !== null && (hook.secret === null || !verifyWebhookSignature({ signature: schedule.signature, secret: hook.secret, headers: request.headers, body: request.body }))) {
			await log("rejected_signature");
			return { _tag: "rejected_signature" };
		}
		const failed = findFailedWebhookFilter(schedule.filters ?? [], request);
		if (failed !== null) {
			if (this.#quiet(task.id, "filtered", now)) await log("filtered", { signatureVerified: signed, error: describeFailedWebhookFilter(failed) });
			giveBack();
			return { _tag: "accepted", deliveryId, outcome: "filtered" };
		}

		const replayKey = dedupeKey(schedule.dedupe?.replayKey, request);
		if (replayKey !== "" && hook.replayKeys.some((entry) => entry.key === replayKey && entry.expiresAt > now)) {
			if (this.#quiet(task.id, "dedupe", now)) await log("duplicate", { signatureVerified: signed });
			giveBack();
			return { _tag: "accepted", deliveryId, outcome: "duplicate" };
		}
		const coalesceKey = dedupeKey(schedule.dedupe?.coalesceKey, request);
		const stored: StoredRequest = { method: request.method, path: request.path, query: request.query, headers: { ...request.headers }, bodyText: request.bodyText };
		const open = coalesceKey === "" ? undefined : hook.pending.find((pending) => pending.coalesceKey === coalesceKey && pending.dueAt > now);
		if (open !== undefined) {
			// The window's run is made from the last request that joined it.
			await this.#update(task.id, (current) => {
				const pending = current.pending.find((candidate) => candidate.deliveryId === open.deliveryId);
				if (pending !== undefined) pending.request = stored;
				claimReplay(current, replayKey, open.deliveryId, now);
				const owner = current.deliveries.find((delivery) => delivery.id === open.deliveryId);
				if (owner !== undefined) Object.assign(owner, requestFields(request));
			});
			if (this.#quiet(task.id, "dedupe", now)) await log("coalesced", { signatureVerified: signed });
			return { _tag: "accepted", deliveryId, outcome: "coalesced" };
		}

		// A run, now or when its window closes: within the task's rate and queue.
		if (hook.pending.length + (this.#queued.get(task.id) ?? 0) >= MAX_QUEUED_PER_TASK) {
			giveBack();
			return { _tag: "rate_limited", outcome: "queue_full" };
		}
		const started = takeSlot(this.#started, task.id, now, { at: now });
		if (started !== "allowed") {
			if (started === "first_refused") await log("rate_limited");
			giveBack();
			return { _tag: "rate_limited", outcome: "rate_limited" };
		}
		giveBack();
		if (coalesceKey !== "") {
			const dueAt = now + (schedule.dedupe?.coalesceWindowSeconds ?? DEFAULT_COALESCE_WINDOW_SECONDS) * 1000;
			await this.#update(task.id, (current) => {
				current.pending.push({ deliveryId, coalesceKey, dueAt, request: stored });
				claimReplay(current, replayKey, deliveryId, now);
			});
			await log("accepted", { signatureVerified: signed, pendingWindow: true });
			return { _tag: "accepted", deliveryId, outcome: "accepted" };
		}
		if (replayKey !== "") await this.#update(task.id, (current) => claimReplay(current, replayKey, deliveryId, now));
		return this.#dispatch(task, deliveryId, request, signed, log, run);
	}

	/** The windows that have closed: each runs its task once, from the last request that joined it. Called by the
	 * scheduler's poll, so a window survives a restart. */
	async runDue(task: (taskId: string) => Task | undefined, run: (task: Task, deliveryId: string, prompt: string) => Promise<void>): Promise<void> {
		const now = this.#now().getTime();
		for (const [taskId, hook] of [...this.#hooks]) {
			for (const pending of hook.pending.filter((candidate) => candidate.dueAt <= now)) {
				await this.#update(taskId, (current) => void (current.pending = current.pending.filter((candidate) => candidate.deliveryId !== pending.deliveryId)));
				const current = task(taskId);
				const request: WebhookTriggerRequest = { ...pending.request, hookId: taskId, token: "", body: new TextEncoder().encode(pending.request.bodyText) };
				const log = (outcome: DeliverySummary["outcome"], details: { signatureVerified?: boolean; missing?: readonly string[]; renderedPrompt?: string; error?: string } = {}) =>
					this.#update(taskId, (stored) => {
						const delivery = stored.deliveries.find((candidate) => candidate.id === pending.deliveryId);
						if (delivery === undefined) return;
						Object.assign(delivery, { outcome, missingFields: [...(details.missing ?? [])], renderedPrompt: details.renderedPrompt?.slice(0, LOG_PROMPT_LIMIT) ?? null, error: details.error ?? null });
						delete (delivery as { pendingWindow?: boolean }).pendingWindow;
					});
				if (current === undefined || current.schedule.type !== "webhook" || !current.enabled) {
					await log("dispatch_failed", { error: "The task was paused, changed or deleted before its window closed." });
					continue;
				}
				await this.#dispatch(current, pending.deliveryId, request, current.schedule.signature !== null, log, run);
			}
		}
	}

	async #dispatch(
		task: Task,
		deliveryId: string,
		request: WebhookTriggerRequest,
		signed: boolean,
		log: (outcome: DeliverySummary["outcome"], details?: { signatureVerified?: boolean; missing?: readonly string[]; renderedPrompt?: string; error?: string }) => Promise<void>,
		run: (task: Task, deliveryId: string, prompt: string) => Promise<void>,
	): Promise<WebhookTriggerResult> {
		// T3 frames request text between tags no request can guess, and says it is untrusted.
		const rendered = renderWebhookPrompt(task.prompt, request, randomBytes(6).toString("hex"));
		if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
			await log("dispatch_failed", { signatureVerified: signed, missing: rendered.missing, renderedPrompt: rendered.prompt, error: PROMPT_TOO_LONG });
			await this.#update(task.id, (current) => void (current.replayKeys = current.replayKeys.filter((entry) => entry.deliveryId !== deliveryId)));
			return { _tag: "accepted", deliveryId, outcome: "prompt_too_long" };
		}
		await log("accepted", { signatureVerified: signed, missing: rendered.missing, renderedPrompt: rendered.prompt });
		this.#queued.set(task.id, (this.#queued.get(task.id) ?? 0) + 1);
		void run(task, deliveryId, rendered.prompt)
			.catch(async (error: unknown) => {
				// The sender may try again: a run that did not start does not use up its replay key.
				await this.#update(task.id, (current) => {
					current.replayKeys = current.replayKeys.filter((entry) => entry.deliveryId !== deliveryId);
					const delivery = current.deliveries.find((candidate) => candidate.id === deliveryId);
					if (delivery !== undefined) Object.assign(delivery, { outcome: "dispatch_failed", error: error instanceof Error ? error.message : String(error) });
				}).catch(() => {});
				this.#log?.warn("a webhook's run was not started", { taskId: task.id, deliveryId, error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => this.#queued.set(task.id, Math.max(0, (this.#queued.get(task.id) ?? 1) - 1)));
		return { _tag: "accepted", deliveryId, outcome: "accepted" };
	}

	/** Whether a quiet outcome is logged this time: T3 logs ten a minute of each kind, so a flood does not fill the log. */
	#quiet(taskId: string, kind: "filtered" | "dedupe", now: number): boolean {
		const key = `${taskId}\u0000${kind}`;
		const recent = (this.#quietLogs.get(key) ?? []).filter((at) => now - at < 60_000);
		if (recent.length >= QUIET_LOG_PER_MINUTE) return false;
		this.#quietLogs.set(key, [...recent, now]);
		return true;
	}

	/** Add a delivery to the task's log, or replace the one of that id, and trim the log as T3 does: 50 deliveries,
	 * with at most 20 filtered and 20 duplicate or coalesced among them. */
	#record(taskId: string, delivery: Delivery): Promise<void> {
		return this.#update(taskId, (hook) => {
			hook.deliveries = [...hook.deliveries.filter((candidate) => candidate.id !== delivery.id), delivery];
			const keep = (matches: (outcome: string) => boolean, limit: number) => {
				const extra = hook.deliveries.filter((candidate) => matches(candidate.outcome)).length - limit;
				if (extra <= 0) return;
				let dropped = 0;
				hook.deliveries = hook.deliveries.filter((candidate) => !(matches(candidate.outcome) && dropped++ < extra));
			};
			keep((outcome) => outcome === "filtered", FILTERED_DELIVERY_RETENTION);
			keep((outcome) => outcome === "duplicate" || outcome === "coalesced", DEDUPE_DELIVERY_RETENTION);
			keep(() => true, DELIVERY_RETENTION);
		});
	}

	#update(taskId: string, change: (hook: Hook) => void): Promise<void> {
		const next = (this.#writes.get(taskId) ?? Promise.resolve()).then(async () => {
			const hook = this.#hooks.get(taskId);
			if (hook === undefined) return;
			const copy = structuredClone(hook);
			change(copy);
			await this.#put(taskId, copy);
		});
		this.#writes.set(taskId, next.catch(() => {}));
		return next;
	}

	async #put(taskId: string, hook: Hook | undefined): Promise<void> {
		const stored = (hook === undefined ? null : (JSON.parse(JSON.stringify(hook)) as JsonValue)) as JsonValue | null;
		await this.#harness.commit(async (tx) => {
			(await tx.doc(HookDoc, taskId, { hook: stored })).hook = stored;
		}, BACKGROUND_CONTEXT);
		if (hook === undefined) this.#hooks.delete(taskId);
		else this.#hooks.set(taskId, hook);
	}
}

const newToken = (): string => randomBytes(32).toString("base64url");

/** T3's `takeRateSlot`: sixty a minute; the first refusal of a run of them is the one that is logged. */
function takeSlot(windows: Map<string, RateWindow>, taskId: string, now: number, slot: { at: number }): "allowed" | "first_refused" | "refused" {
	const current = windows.get(taskId);
	const recent = (current?.taken ?? []).filter((entry) => now - entry.at < 60_000);
	if (recent.length >= RATE_LIMIT_PER_MINUTE) {
		windows.set(taskId, { taken: recent, refusalLogged: true });
		return current?.refusalLogged === true ? "refused" : "first_refused";
	}
	windows.set(taskId, { taken: [...recent, slot], refusalLogged: false });
	return "allowed";
}

function claimReplay(hook: Hook, replayKey: string, deliveryId: string, now: number): void {
	hook.replayKeys = hook.replayKeys.filter((entry) => entry.expiresAt > now);
	if (replayKey !== "") hook.replayKeys.push({ key: replayKey, deliveryId, expiresAt: now + REPLAY_KEY_TTL_MS });
}

/** The request as the log keeps it: credentials redacted (T3's `redactHeaders`, `redactQuery`), the body cut at 64 KB. */
function requestFields(request: WebhookTriggerRequest): Pick<Delivery, "method" | "contentType" | "bodyBytes" | "query" | "headers" | "body" | "bodyTruncated"> {
	const bytes = request.body.byteLength;
	const truncated = bytes > LOG_BODY_LIMIT;
	return {
		method: request.method,
		contentType: request.headers["content-type"] ?? null,
		bodyBytes: bytes,
		query: redactQuery(request.query),
		headers: redactHeaders(request.headers),
		body: truncated ? new TextDecoder().decode(request.body.subarray(0, LOG_BODY_LIMIT)) : request.bodyText,
		bodyTruncated: truncated,
	} as Pick<Delivery, "method" | "contentType" | "bodyBytes" | "query" | "headers" | "body" | "bodyTruncated">;
}

function deliveryRecord(
	id: string,
	taskId: string,
	receivedAt: number,
	request: WebhookTriggerRequest,
	outcome: DeliverySummary["outcome"],
	details: { signatureVerified?: boolean; missing?: readonly string[]; renderedPrompt?: string; error?: string; pendingWindow?: boolean },
): Delivery {
	return {
		id,
		taskId,
		receivedAt: new Date(receivedAt).toISOString(),
		...requestFields(request),
		outcome,
		signatureVerified: details.signatureVerified ?? false,
		...(details.pendingWindow === true ? { pendingWindow: true } : {}),
		missingFields: [...(details.missing ?? [])],
		error: details.error ?? null,
		renderedPrompt: details.renderedPrompt?.slice(0, LOG_PROMPT_LIMIT) ?? null,
	} as unknown as Delivery;
}
