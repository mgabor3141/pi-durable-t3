// A tool call that answers Stop at once. pi-durable ends a run only when each of its tool calls has returned, and it
// tells a call to stop through `context.abortSignal` (execute's third argument); a tool that does not listen holds the
// run, and the user's Stop, until its work ends on its own. This wrapper makes such a call return the moment it is
// aborted. The work it started is not cancelled by this (a tool that can cancel it should pass the signal on as well);
// its result is dropped, and a failure it ends with later is ignored.
import type { Context } from "@earendil-works/chord/context";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

type Execute = (args: never, api: never, context: Context) => Promise<unknown>;

/** `tool`, whose call rejects as soon as its `context.abortSignal` fires, whatever the tool does with it. */
export function abortable<T extends ToolRegistration>(tool: T): T {
	const execute = tool.execute as unknown as Execute;
	const wrapped: Execute = (args, api, context) => {
		const signal = context?.abortSignal;
		const work = Promise.resolve().then(() => execute(args, api, context));
		if (signal === undefined) return work;
		return new Promise((resolve, reject) => {
			const stop = () => {
				work.catch(() => {});
				reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			if (signal.aborted) return stop();
			signal.addEventListener("abort", stop, { once: true });
			work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	};
	return { ...tool, execute: wrapped } as unknown as T;
}

/** `extension` with every tool `abortable`. */
export function abortableExtension(extension: Extension): Extension {
	const tools = (extension as { tools?: readonly ToolRegistration[] }).tools;
	return tools === undefined ? extension : ({ ...extension, tools: tools.map(abortable) } as Extension);
}
