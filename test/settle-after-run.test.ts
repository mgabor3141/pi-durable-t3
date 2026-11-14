// T3's `settleAfterRun` decision (0.1.9): a thread whose own agent asked to settle it is settled when its turn ends, but
// only if nothing but subagent reports came after, they have finished, and none of them failed. A person's message, or
// a report that is still running, must not leave a settled thread that is working.
import { expect, it } from "vitest";
import { settleVerdict } from "../src/t3/thread-ops.ts";

type Run = { id: string; ordinal: number; status: string; userMessageId: string };
const run = (ordinal: number, status: string, userMessageId: string): Run => ({ id: `r${ordinal}`, ordinal, status, userMessageId });
const verdict = (runs: Run[], messages: { id: string; role: string; runId: string }[] = []) => settleVerdict({ runs, messages } as never, 1);
const asked = run(1, "completed", "m1");

it("settles after the run when nothing followed, naming the latest run", () => {
	expect(verdict([asked])).toEqual({ latestRunId: "r1" });
	expect(verdict([run(0, "completed", "m0"), asked]), "earlier runs do not count").toEqual({ latestRunId: "r1" });
});

it("leaves the thread active when a person or another agent wrote to it since", () => {
	expect(verdict([asked, run(2, "completed", "m2")])).toBe("leave");
	expect(verdict([asked, run(2, "queued", "m2")])).toBe("leave");
	// A steer into a report's run is a message too.
	expect(verdict([asked, run(2, "completed", "n-abc")], [{ id: "m3", role: "user", runId: "r2" }])).toBe("leave");
});

it("waits while a report's run is working, and settles once it completed", () => {
	for (const status of ["preparing", "starting", "running", "waiting"]) expect(verdict([asked, run(2, status, "n-abc")]), status).toBeUndefined();
	expect(verdict([asked, run(2, "completed", "n-abc")], [{ id: "n-abc", role: "user", runId: "r2" }])).toEqual({ latestRunId: "r2" });
	expect(verdict([asked, run(2, "completed", "n-abc"), run(3, "running", "n-def")]), "any report still working").toBeUndefined();
	// A report that waits in the queue has not started work: the settle names it, so its start refuses a late settle.
	expect(verdict([asked, run(2, "queued", "n-abc")])).toEqual({ latestRunId: "r2" });
});

it("leaves the thread active when a report's run ended other than completed", () => {
	for (const status of ["failed", "interrupted", "cancelled"]) expect(verdict([asked, run(2, status, "n-abc")]), status).toBe("leave");
});
