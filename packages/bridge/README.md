# @mgabor3141/pi-durable-t3

[T3 Code](https://github.com/pingdotgg/t3code) as the frontend for a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
`Harness` you own. Bridges T3 release **v0.1.1** (protocol 2); it ships T3's web app, served from the same origin.
Experimental.

```sh
pnpm add @mgabor3141/pi-durable-t3 @earendil-works/chord @earendil-works/pi-ai @earendil-works/pi-durable
```

The pi packages are peer dependencies (`^1.4.0`): you already have them, and the bridge must share your copy of `chord`.
Node `>=22.19.0`.

```ts
import { attachT3, mintPairingCode } from "@mgabor3141/pi-durable-t3";

const t3 = await attachT3(harness, { models, stateDir: "./t3-state" });  // http://127.0.0.1:3774
harness.resume();                                                        // after attachT3 resolves
console.log(`pair: http://127.0.0.1:3774/pair#token=${mintPairingCode("./t3-state").code}`);
```

## Public API (`"."` is the only entry point)

- `attachT3(harness, options): Promise<T3Attachment>` and the `AttachT3Options` type (options are documented in the
  type's comments: `models`, `stateDir`, `scratchDir`, `listen`, `label`, `webApp`, `corsOrigins`, `tokenTtlSeconds`,
  `tailscaleServe`, `titleThread`, `log`).
- `T3Attachment`: `closed`, `close()`, `setTitle(threadId, title)`.
- `mintPairingCode(stateDir): { code }`: a single-use pairing code, no server needed.
- `ConfigError`, `Logger`, `TitleThread`, `TitleThreadRequest`, `DESKTOP_APP_ORIGIN`.

The web app comes from `@mgabor3141/pi-durable-t3-web` (a dependency) and is always served at `/`; `webApp` points at
another built T3 web app directory instead.

## Bundled T3 code

T3's `@t3tools/contracts` (not published to npm) is bundled into `dist/`; its MIT license is in `THIRD_PARTY_LICENSES`.
`effect` and `@effect/platform-node` stay external, exact dependencies, so the bridge and the bundled contracts share
one Effect: do not override `effect` to another version.

Source and design notes: <https://github.com/mgabor3141/pi-durable-t3>.
