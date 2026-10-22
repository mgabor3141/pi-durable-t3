// Keep only the declaration files reachable from dist/bridge.d.ts (the public surface), rewriting `.ts` import
// specifiers to `.js`. Fails if a kept file references an internal-only dependency (the vendored contracts).
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const keep = new Set();
const queue = ["dist/bridge.d.ts"];
while (queue.length > 0) {
	const file = queue.pop();
	if (keep.has(file)) continue;
	keep.add(file);
	const text = readFileSync(file, "utf8").replace(/(from "\.[^"]*)\.ts"/g, '$1.js"');
	writeFileSync(file, text);
	if (/@t3tools\/contracts/.test(text)) throw new Error(`${file} references @t3tools/contracts: the public types leak T3's contracts`);
	for (const m of text.matchAll(/from "(\.[^"]+)\.js"/g)) queue.push(join(dirname(file), `${m[1]}.d.ts`));
}
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (path.endsWith(".d.ts") && !keep.has(path)) rmSync(path);
	}
	if (readdirSync(dir).length === 0 && dir !== "dist") rmSync(dir, { recursive: true });
})("dist");
console.log("declarations:", [...keep].join(" "));
