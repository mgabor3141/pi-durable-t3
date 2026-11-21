// The `notifyUser` hook's types (`user-notifications.ts` decides when it is called). Apart from that file, so the
// published declarations reach no internals.

/** One thing to tell a user who is not looking at T3 (`notifyUser`). */
export type UserNotification = {
	/** `approval`: the agent waits for the user to approve something. `input`: it waits for an answer (a question, a
	 * secret). `completed`: the thread's run finished. `failed`: it failed, a provider's limit included. */
	readonly kind: "approval" | "input" | "completed" | "failed";
	readonly threadId: string;
	/** This host's T3 environment. T3's apps open the thread at `/threads/<environmentId>/<threadId>`: the phone app as
	 * `t3code://threads/<environmentId>/<threadId>`. */
	readonly environmentId: string;
	readonly threadTitle: string;
	readonly projectTitle: string;
	/** T3's words for `kind`, as its own phone alerts say them: "Approval needed", "Waiting for input", "Agent finished",
	 * "Agent failed". */
	readonly headline: string;
};

/** Sends one notification to the user's devices. A rejection is logged; nothing is sent again. */
export type NotifyUser = (notification: UserNotification) => Promise<void>;
