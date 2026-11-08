// One rule for every image the model is sent: it must be an image a provider can read. A broken one in the transcript is
// sent again with every request, the provider refuses each (Anthropic: "the image could not be read (image file is
// truncated)"), and the thread cannot continue. The check reads only the bytes: base64 that decodes, a format providers
// take inline (PNG, JPEG, GIF, WebP) read from the bytes themselves, and a file that is complete: PNG's chunks up to IEND,
// JPEG's segments and scan data up to EOI, GIF's blocks up to the trailer, WebP's RIFF length. A declared type the bytes
// contradict is corrected rather than refused. Size and dimensions are not checked: the model's limits are what images
// are resized to, not what providers refuse.
//
// `imageCheckExtension` applies it where images reach the model: each tool result (`afterTool`, so the agent sees why in
// the same turn), and each request (`beforeRequest`, for a transcript that holds a broken image already). A refused image
// becomes a text saying why; the transcript itself is never rewritten.
import type { Extension, ToolDiagnostic, ToolExecutionResult } from "@earendil-works/pi-durable";
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

export type ImageCheck = { readonly ok: true; readonly mimeType: string } | { readonly ok: false; readonly reason: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` (base64) is an image a provider can read, and its type as the bytes say. */
export function checkImageData(data: string): ImageCheck {
	if (data.length === 0) return { ok: false, reason: "it is empty" };
	if (data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, reason: "its data is not valid base64" };
	return checkImage(Buffer.from(data, "base64"));
}

/** Whether `bytes` are a complete PNG, JPEG, GIF or WebP image, and which. */
export function checkImage(bytes: Uint8Array): ImageCheck {
	const size = `${bytes.length.toLocaleString("en-US")} bytes`;
	const truncated = (format: string): ImageCheck => ({ ok: false, reason: `the ${format} ends early, at ${size}: the file is incomplete (copied or read while it was still being written?)` });
	const corrupt = (format: string): ImageCheck => ({ ok: false, reason: `the ${format} is damaged (${size})` });
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return pngComplete(bytes) ? { ok: true, mimeType: "image/png" } : truncated("PNG");
	if (startsWith(bytes, [0xff, 0xd8])) {
		const end = jpegEnd(bytes);
		return end === "complete" ? { ok: true, mimeType: "image/jpeg" } : end === "truncated" ? truncated("JPEG") : corrupt("JPEG");
	}
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
		const end = gifEnd(bytes);
		return end === "complete" ? { ok: true, mimeType: "image/gif" } : end === "truncated" ? truncated("GIF") : corrupt("GIF");
	}
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
		return bytes.length >= 8 + readU32LE(bytes, 4) ? { ok: true, mimeType: "image/webp" } : truncated("WebP");
	}
	return { ok: false, reason: `it is not a PNG, JPEG, GIF or WebP image (${size})` };
}

/** A PNG is complete when its chunks, each within the file, reach IEND. */
function pngComplete(bytes: Uint8Array): boolean {
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = readU32BE(bytes, at);
		const isEnd = bytes[at + 4] === 0x49 && bytes[at + 5] === 0x45 && bytes[at + 6] === 0x4e && bytes[at + 7] === 0x44;
		at += 12 + length;
		if (at > bytes.length) return false;
		if (isEnd) return true;
	}
	return false;
}

/** A JPEG is complete when its segments, and the scan data after each SOS, reach EOI. */
function jpegEnd(bytes: Uint8Array): "complete" | "truncated" | "corrupt" {
	let at = 2;
	for (;;) {
		if (at + 2 > bytes.length) return "truncated";
		if (bytes[at] !== 0xff) return "corrupt";
		const marker = bytes[at + 1]!;
		if (marker === 0xff) {
			at += 1; // fill byte
			continue;
		}
		if (marker === 0xd9) return "complete";
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		if (at + 4 > bytes.length) return "truncated";
		const end = at + 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
		if (end > bytes.length) return "truncated";
		at = end;
		if (marker !== 0xda) continue;
		// Scan data: up to the next marker; FF00 is a stuffed FF, FFD0–FFD7 a restart, FFFF fill.
		for (;;) {
			if (at + 1 >= bytes.length) return "truncated";
			if (bytes[at] !== 0xff) {
				at += 1;
				continue;
			}
			const next = bytes[at + 1]!;
			if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
				at += next === 0xff ? 1 : 2;
				continue;
			}
			break;
		}
	}
}

/** A GIF is complete when its blocks reach the trailer. */
function gifEnd(bytes: Uint8Array): "complete" | "truncated" | "corrupt" {
	if (bytes.length < 13) return "truncated";
	const packed = bytes[10]!;
	let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
	const subBlocks = (): boolean => {
		for (;;) {
			if (at >= bytes.length) return false;
			const length = bytes[at]!;
			at += 1 + length;
			if (length === 0) return true;
		}
	};
	for (;;) {
		if (at >= bytes.length) return "truncated";
		const block = bytes[at]!;
		if (block === 0x3b) return "complete";
		if (block === 0x21) {
			at += 2;
			if (!subBlocks()) return "truncated";
		} else if (block === 0x2c) {
			if (at + 10 > bytes.length) return "truncated";
			const local = bytes[at + 9]!;
			at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1;
			if (!subBlocks()) return "truncated";
		} else return "corrupt";
	}
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}
const readU32BE = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const readU32LE = (bytes: Uint8Array, at: number) => bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16) + ((bytes[at + 3]! << 24) >>> 0);

/** What the model reads in place of a refused image. */
export const imageRefusal = (reason: string): string => `[Image not shown to the model: ${reason}.]`;

type Block = { readonly type: string; readonly data?: unknown; readonly mimeType?: unknown };
const isImage = (block: unknown): block is { type: "image"; data: string; mimeType: string } =>
	typeof block === "object" && block !== null && (block as Block).type === "image" && typeof (block as Block).data === "string";

/** `blocks` with each image checked: a readable one kept (its type corrected), a broken one a text saying why. Returns the
 * same array when nothing changed, and the reasons of the refused ones. */
export function checkImageBlocks<B>(blocks: readonly B[]): { readonly blocks: readonly B[]; readonly refused: readonly string[] } {
	let changed = false;
	const refused: string[] = [];
	const checked = blocks.map((block) => {
		if (!isImage(block)) return block;
		const verdict = checkImageData(block.data);
		if (verdict.ok) {
			if (verdict.mimeType === block.mimeType) return block;
			changed = true;
			return { ...block, mimeType: verdict.mimeType };
		}
		changed = true;
		refused.push(verdict.reason);
		return { type: "text", text: imageRefusal(verdict.reason) } as B;
	});
	return { blocks: changed ? checked : blocks, refused };
}

/** Every image a structured value holds, checked: the reasons of the broken ones, and the value with each readable
 * one's type corrected (the same value when none needed it). */
function checkStructured(value: unknown): { readonly value: unknown; readonly changed: boolean; readonly refused: readonly string[] } {
	const refused: string[] = [];
	let changed = false;
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (typeof node !== "object" || node === null) return node;
		if (isImage(node)) {
			const verdict = checkImageData(node.data);
			if (!verdict.ok) refused.push(verdict.reason);
			if (!verdict.ok || verdict.mimeType === node.mimeType) return node;
			changed = true;
			return { ...node, mimeType: verdict.mimeType };
		}
		return Object.fromEntries(Object.entries(node).map(([key, field]) => [key, walk(field)]));
	};
	const walked = walk(value);
	return { value: changed ? walked : value, changed, refused };
}

/** A tool result with its images checked. An image a program would get (`structuredOutput`, as a script's `read` gets
 * one) that is broken makes the call an error saying why, so the script's call rejects; in the model's output a broken
 * image becomes a text, and the rest of the output stays. */
export function checkToolResult(result: ToolExecutionResult): ToolExecutionResult | undefined {
	const output = result.output === undefined ? undefined : checkImageBlocks(result.output);
	const structured = result.structuredOutput === undefined ? undefined : checkStructured(result.structuredOutput);
	const refused = [...new Set([...(output?.refused ?? []), ...(structured?.refused ?? [])])];
	if (structured !== undefined && structured.refused.length > 0) {
		const message = refused.map(imageRefusal).join(" ");
		const diagnostic: ToolDiagnostic = { severity: "error", code: "unusable_image", message };
		const { structuredOutput: _dropped, ...rest } = result;
		return { ...rest, isError: true, output: [{ type: "text", text: message }], diagnostics: [...(result.diagnostics ?? []), diagnostic] };
	}
	const outputChanged = output !== undefined && output.blocks !== result.output;
	const structuredChanged = structured?.changed === true;
	if (!outputChanged && !structuredChanged) return undefined;
	return {
		...result,
		...(outputChanged ? { output: output!.blocks as ToolExecutionResult["output"] } : {}),
		...(structuredChanged ? { structuredOutput: structured!.value as ToolExecutionResult["structuredOutput"] } : {}),
	};
}

/** The image check where images reach the model: each tool result, and each request. */
export function imageCheckExtension(): Extension {
	return defineExtension({
		name: "image-check",
		hooks: [
			hook(ToolTask, { afterTool: (_call, result) => checkToolResult(result) }),
			hook(GenerationTask, {
				beforeRequest: ({ messages }) => {
					let changed = false;
					const checked = messages.map((message) => {
						if (message.role === "assistant" || typeof message.content === "string") return message;
						const { blocks } = checkImageBlocks(message.content as readonly unknown[]);
						if (blocks === message.content) return message;
						changed = true;
						return { ...message, content: blocks } as typeof message;
					});
					return changed ? { messages: checked } : undefined;
				},
			}),
		],
	});
}
