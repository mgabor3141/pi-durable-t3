// The image data a thread's transcript carries stays in the store: an open thread keeps its transcript in memory for
// the projection, which shows an image as a marker and never reads its data. A screenshot is a few hundred kilobytes of
// base64, and a long thread that browses holds hundreds: kept, they were most of the host's memory. Each image block
// a thread view keeps is replaced by one that says where its data is; T3's `tool-output-image` asset reads it from
// there when a client shows the image.
import type { EntryRecord } from "./model-types.ts";

/** Where an image's data is: the entry, its model message and the block in that message's content, and its length. */
export type ImageAt = { readonly entryId: number; readonly message: number; readonly block: number; readonly length: number };

/** An image block whose data was left in the store. */
export type OmittedImage = { readonly type: "image"; readonly mimeType: string; readonly omitted: ImageAt };

export function omittedImage(block: unknown): ImageAt | undefined {
	const omitted = (block as { omitted?: unknown } | null)?.omitted;
	return typeof omitted === "object" && omitted !== null ? (omitted as ImageAt) : undefined;
}

/** The entry with every image block of its model messages replaced by an `OmittedImage`; the entry itself without one. */
export function withoutImageData(entry: EntryRecord): EntryRecord {
	const messages = entry.model as readonly { content?: unknown }[] | undefined;
	if (!Array.isArray(messages) || !messages.some((message) => Array.isArray(message?.content) && message.content.some(isImageWithData))) return entry;
	const model = messages.map((message, m) =>
		!Array.isArray(message?.content)
			? message
			: {
					...message,
					content: message.content.map((block: { mimeType?: unknown; data: string }, b: number) =>
						isImageWithData(block) ? ({ type: "image", mimeType: block.mimeType, omitted: { entryId: entry.id, message: m, block: b, length: block.data.length } } satisfies OmittedImage) : block,
					),
				},
	);
	return { ...entry, model } as unknown as EntryRecord;
}

function isImageWithData(block: unknown): block is { type: "image"; mimeType: string; data: string } {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image" && typeof (block as { data?: unknown }).data === "string";
}

/** The data of the image `at` names, from the entry as stored; `undefined` when it is not there. */
export function imageDataOf(entry: EntryRecord | undefined, at: ImageAt): string | undefined {
	const message = (entry?.model as readonly { content?: unknown }[] | undefined)?.[at.message];
	const block = Array.isArray(message?.content) ? (message.content[at.block] as unknown) : undefined;
	return isImageWithData(block) ? block.data : undefined;
}
