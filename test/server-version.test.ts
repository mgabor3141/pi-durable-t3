// `serverVersion` is the T3 release at the pin; keep it equal to `T3_TAG` in dev/setup-t3.sh.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SERVER_VERSION } from "../src/t3/http.ts";

it("SERVER_VERSION is the pinned T3 tag", () => {
	const tag = /^T3_TAG=v(.+)$/m.exec(readFileSync(new URL("../dev/setup-t3.sh", import.meta.url), "utf8"))?.[1];
	expect(SERVER_VERSION).toBe(tag);
});
