// The asset route's headers (T3's `assetResponseHeaders` for an inline asset): HTML runs sandboxed with an opaque origin,
// so a page the agent wrote cannot use the session cookie on this host's API when its URL is opened in a tab of its own;
// SVG and other XML types run no scripts at all.
import { expect, it } from "vitest";
import { assetResponse } from "../src/t3/http.ts";

it("sandboxes HTML as T3 does, and serves it as UTF-8", () => {
	expect(assetResponse("text/html")).toEqual({
		contentType: "text/html; charset=utf-8",
		headers: {
			"cache-control": "private, max-age=3600",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
		},
	});
	expect(assetResponse("TEXT/HTML; charset=latin1").headers["content-security-policy"]).toContain("sandbox");
});

it("gives SVG T3's style-only policy, and other XML none", () => {
	expect(assetResponse("image/svg+xml").headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
	expect(assetResponse("application/xhtml+xml").headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
	expect(assetResponse("text/xml").headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
});

it("leaves images, media and PDFs as they are", () => {
	for (const type of ["image/png", "video/mp4", "application/pdf", "text/css"]) {
		expect(assetResponse(type)).toEqual({ contentType: type, headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
	}
});
