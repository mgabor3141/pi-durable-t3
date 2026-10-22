// `serverVersion` is the T3 release at the pin (`T3_TAG` in dev/t3-pin.sh).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SERVER_VERSION } from "../src/t3/http.ts";

const tag = /^T3_TAG=v(.+)$/m.exec(readFileSync(new URL("../dev/t3-pin.sh", import.meta.url), "utf8"))?.[1];

it("SERVER_VERSION is the pinned T3 tag", () => {
	expect(tag).toBeDefined();
	expect(SERVER_VERSION).toBe(tag);
});
