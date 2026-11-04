import { describe, expect, it } from "vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { compactThreadProjection } from "../src/t3/compact.ts";

function projection(input: {
	threadId: string;
	items: unknown[];
	visible: Array<{ visibility: "local" | "inherited"; sourceThreadId: string; item: unknown }>;
}): OrchestrationV2ThreadProjection {
	return {
		thread: { id: input.threadId },
		turnItems: input.items,
		visibleTurnItems: input.visible.map((row, position) => ({ position, ...row })),
	} as unknown as OrchestrationV2ThreadProjection;
}

describe("compactThreadProjection", () => {
	it("omits local visible items and marks the snapshot", () => {
		const first = { id: "a" };
		const second = { id: "b" };
		const full = projection({
			threadId: "t",
			items: [first, second],
			visible: [
				{ visibility: "local", sourceThreadId: "t", item: first },
				{ visibility: "inherited", sourceThreadId: "other", item: second },
			],
		});

		const compact = compactThreadProjection(full);

		expect(compact.turnItemsOmitLocalVisible).toBe(true);
		expect(compact.projection.turnItems).toEqual([second]);
		expect(compact.projection.visibleTurnItems).toHaveLength(2);
	});

	it("leaves a projection with no local visible items unchanged", () => {
		const item = { id: "a" };
		const full = projection({
			threadId: "t",
			items: [item],
			visible: [{ visibility: "inherited", sourceThreadId: "other", item }],
		});

		const compact = compactThreadProjection(full);

		expect(compact.turnItemsOmitLocalVisible).toBeUndefined();
		expect(compact.projection).toBe(full);
	});

	it("does not compact when identity was lost", () => {
		const full = projection({
			threadId: "t",
			items: [{ id: "a" }],
			visible: [{ visibility: "local", sourceThreadId: "t", item: { id: "a" } }],
		});

		const compact = compactThreadProjection(full);

		expect(compact.turnItemsOmitLocalVisible).toBeUndefined();
		expect(compact.projection).toBe(full);
	});
});
