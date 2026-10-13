// The facet's logger contract. Everything the facet logs goes through this, so the host controls the sink.
export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}
