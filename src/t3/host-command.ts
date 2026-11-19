// Public: kept apart from the bridge config (which reaches the settings store and T3's contracts), so the declarations
// an integrator imports stay free of the vendored contracts (`build/prune-types.mjs`).

/**
 * A slash command of the integrator's own: listed in T3's composer menu, and answered in the thread it is sent in as
 * `/context` is, shown there and kept nowhere (never sent to the model, gone after a restart). A command that throws
 * is answered with its error's message.
 */
export type HostCommand = {
	/** Without the slash: lowercase letters, digits and dashes. */
	readonly name: string;
	readonly description: string;
	/** What may follow the name, for the composer's hint. */
	readonly hint?: string;
	/** The answer, as Markdown, for the thread the command was sent in; `argument` is what followed the name, trimmed. */
	run(input: { readonly threadId: string; readonly argument: string }): Promise<string>;
};
