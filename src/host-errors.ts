// The host's stable error codes: a caller switches on the code, so renaming one is a breaking change. The objects layer
// maps each to a `ChordError` with the code as its `reason` (design.md). Kept free of `chord` so the core stays testable alone.
type HostErrorCode = "unknown_project" | "unknown_thread" | "unknown_queued_message" | "turn_running" | "not_rewindable";

export class HostError extends Error {
	readonly code: HostErrorCode;

	constructor(code: HostErrorCode, message: string) {
		super(message);
		this.name = "HostError";
		this.code = code;
	}
}

export function hostError(code: HostErrorCode, message: string): HostError {
	return new HostError(code, message);
}
