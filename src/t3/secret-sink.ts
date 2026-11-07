// Public: kept apart from `secret-requests.ts` (which imports T3's contracts), so the declarations an integrator imports
// stay free of the vendored contracts (`build/prune-types.mjs`).

/** Where an answered secret goes. The integrator's: this host keeps no secret store of its own. */
export interface SecretSink {
	save(name: string, value: string): Promise<void>;
}
