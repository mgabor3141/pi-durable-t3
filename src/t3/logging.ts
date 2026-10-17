// The facet's logger contract. Everything the facet logs goes through this, so the host controls the sink.
export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

/** A logger that says nothing — `attachT3`'s default when the caller passes no `log`.
 * The facet's refusals are answered to the client, so silence loses no contract guarantee. */
export const nullLogger: Logger = { info: () => {}, warn: () => {} };

