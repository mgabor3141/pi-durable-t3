# Example: a coding agent in T3 Code

pi-durable's coding-agent recipe (`read`/`write`/`edit`/`bash`, a base prompt, models from your pi config)
with the bridge attached. It's the agent we test the bridge with, and a worked example of
[`attachT3`](../../README.md#attach-it-to-your-own-agent).

**It runs `bash` as your user, with no approvals**, in the project folders you add.

## Run it

From the repo root:

```sh
pnpm install
pnpm setup:t3     # fetch T3 at the pinned commit, vendor its contracts, download its web app
pnpm start        # the agent; it serves T3's web app on 127.0.0.1:3774
pnpm start pair   # a single-use pairing code and links
```

The host serves T3's web app from its own origin, so `pair` prints one link
(`http://127.0.0.1:3774/pair#token=…`). **Open it in a browser:** the page pairs the browser and lands you in
the app, where this machine (the agent) is the primary environment. You can add a project (Settings →
Connections → Add a project), start a thread, or start one without a project.

You can also paste the same link into T3's **desktop app** to add this machine as a second computer there. The
app's first-run wizard lists only Codex and Claude as agents to add; that's expected (pi is already the
primary, served here).

- Models and credentials come from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). None configured:
  `PI_DURABLE_T3_FAKE=1 pnpm start` uses an offline reply model.
- `pnpm start pair` works while the host is running; the code is single-use.

## Config

Optional: `~/.config/pi-durable-t3/config.toml` (`$XDG_CONFIG_HOME`). [`config.example.toml`](config.example.toml)
lists every key with its default. Most map straight onto `attachT3` options:

The web app is served from the host's own origin (the built app lives in the repo's `web-dist/`, overridable
with `PI_DURABLE_T3_WEB_DIST`); there is no separate web server.

| Key | `attachT3` option |
|---|---|
| `listen` | `listen` |
| `label` | `label` |
| `scratch_dir` | `scratchDir` |
| `token_ttl_days` | `tokenTtlSeconds` |
| `cors_origins` | `corsOrigins` |
| `instructions` | none: the agent's system prompt, added to every thread |

`--root <dir>` puts config and data in one directory instead of the XDG locations.

## Files

In `~/.local/share/pi-durable-t3/` (`$XDG_DATA_HOME`), or `<dir>` with `--root`:

| Path | What | Owner |
|---|---|---|
| `durable.db`, `models-store.json` | conversations, model choices | the agent (pi-durable) |
| `t3/` | `t3-settings.json`, `projects.json`, `auth.json` | the bridge (`stateDir`) |
| `scratch/` | one folder per "No project" thread | agent work output |

The web app is served from the repo's `web-dist/` (T3's own build, fetched by `setup:t3`, overridable with
`PI_DURABLE_T3_WEB_DIST`), not the data dir — a build artifact, not runtime state.

`t3/` pairs with `durable.db`: back up and move them together. A file that doesn't parse stops the host with
a message naming it.

## Over Tailscale

Set `listen` to the machine's tailnet IP (no TLS; the tailnet is the boundary). The host serves the web app on
that same origin, so a browser pointed at the pairing link (`http://<tailnet-ip>:3774/pair#token=…`) pairs and
opens the app there; the browser-session cookie is bound to that host.
