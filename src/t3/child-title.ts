// The title T3 gives a child thread (`packages/provider-core/src/server/subagentProjection.ts`, `subagentThreadTitle`): the
// label, else the prompt, clipped to 72 characters; else "<parent> subagent <n>".

const trimmed = (value: string | null | undefined): string | undefined => {
	const result = value?.trim();
	return result !== undefined && result.length > 0 ? result : undefined;
};

export function subagentThreadTitle(input: { parentTitle: string; title: string | null; prompt: string; ordinal: number }): string {
	const detail = trimmed(input.title) ?? trimmed(input.prompt);
	if (detail === undefined) return `${input.parentTitle} subagent ${input.ordinal}`;
	return detail.length > 72 ? `${detail.slice(0, 69)}...` : detail;
}
