// Serve a built SPA directory with index.html fallback. usage: node dev/serve-static.mjs <dir> <port>
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";
const [dir, port] = [process.argv[2], Number(process.argv[3] ?? 5733)];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
http.createServer((req, res) => {
	const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
	let file = join(dir, path);
	if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
	res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.error(`static ${dir} on ${port}`));
