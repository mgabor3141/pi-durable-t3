// T3's settings-file cases (apps/server/src/serverSettings.test.ts), ported to the store that answers
// `server.updateSettings`: a nested patch keeps its siblings, an edit made to the file while the host runs is the merge
// base for the next save, a file that no longer parses is refused and left as it is, and a symlinked settings file stays
// a link.
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServerSettingsStore, SETTINGS_FILE, SettingsReadError } from "../src/settings.ts";
import { tempRoot } from "./temp-root.ts";

const stored = async (dir: string) => JSON.parse(await readFile(join(dir, SETTINGS_FILE), "utf8")) as Record<string, Record<string, unknown>>;

describe("the settings file, as T3 treats it", () => {
	it("deep merges nested settings updates without dropping siblings", async () => {
		const dir = await tempRoot();
		const store = ServerSettingsStore.open(dir);
		store.update({ observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" } } as never);
		const next = store.update({ observability: { otlpMetricsUrl: "http://localhost:4318/v1/metrics" } } as never);
		expect(next.observability.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
		expect(next.observability.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
	});

	it("keeps an external settings edit made while the host runs", async () => {
		const dir = await tempRoot();
		const store = ServerSettingsStore.open(dir);
		store.current();
		await writeFile(join(dir, SETTINGS_FILE), `{ "responseStreamingMode": "turn" }`);
		store.update({ observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" } } as never);
		const saved = await stored(dir);
		expect(saved["responseStreamingMode"]).toBe("turn");
		expect(saved["observability"]?.["otlpTracesUrl"]).toBe("http://localhost:4318/v1/traces");
		expect(store.current().responseStreamingMode).toBe("turn");
	});

	it("refuses to save over a settings file it cannot parse", async () => {
		const dir = await tempRoot();
		const store = ServerSettingsStore.open(dir);
		const raw = `{ "responseStreamingMode": "turn", `;
		await writeFile(join(dir, SETTINGS_FILE), raw);
		expect(() => store.update({ observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" } } as never)).toThrow(SettingsReadError);
		expect(await readFile(join(dir, SETTINGS_FILE), "utf8")).toBe(raw);
	});

	it("saves through a symlinked settings file without replacing the link", async () => {
		const dir = await tempRoot();
		const dotfiles = join(dir, "dotfiles");
		await mkdir(dotfiles);
		const target = join(dotfiles, "settings.json");
		await writeFile(target, `{ "responseStreamingMode": "turn" }`);
		await symlink(target, join(dir, SETTINGS_FILE));
		const store = ServerSettingsStore.open(dir);
		store.update({ responseStreamingMode: "paragraph" } as never);
		expect(await readlink(join(dir, SETTINGS_FILE))).toBe(target);
		// The file is sparse ("paragraph" is the default), so read it back as the next boot does.
		expect(ServerSettingsStore.open(dotfiles.replace(/dotfiles$/, "")).current().responseStreamingMode).toBe("paragraph");
		expect(await readFile(target, "utf8")).not.toContain("turn");
	});
});
