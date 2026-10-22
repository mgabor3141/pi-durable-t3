// `serverVersion` is the T3 release at the pin (`T3_TAG` in dev/t3-pin.sh); the web package's version IS that version,
// and the web package records the tag in its metadata.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SERVER_VERSION } from "../src/t3/http.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tag = /^T3_TAG=v(.+)$/m.exec(read("../dev/t3-pin.sh"))?.[1];
const pkg = (name: string) => JSON.parse(read(`../packages/${name}/package.json`)) as { version: string; t3?: { tag: string }; dependencies: Record<string, string> };

it("SERVER_VERSION is the pinned T3 tag", () => {
	expect(tag).toBeDefined();
	expect(SERVER_VERSION).toBe(tag);
});

it("the web package carries the pinned T3 version and records the tag", () => {
	expect(pkg("web").version).toBe(tag);
	expect(pkg("web").t3?.tag).toBe(`v${tag}`);
	expect(pkg("bridge").dependencies["@mgabor3141/pi-durable-t3-web"]).toBe("workspace:*");
});
