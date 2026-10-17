# Example: a coding agent in T3 Code

pi-durable's coding-agent recipe (`read`/`write`/`edit`/`bash`, a base prompt, models from your pi config)
with the bridge attached. It's the agent we test the bridge with, and a worked example of
[`attachT3`](../../README.md#attach-it-to-your-own-agent).

**It runs `bash` as your user, with no approvals**, in the project folders you add.

## Run it

From the repo root:

```sh
pnpm install
pnpm setup:t3     # fetch T3 at the pinned commit, vendor its contracts, build the web app
pnpm start        # the agent, on 127.0.0.1:3774
pnpm start pair   # a single-use pairing code and links
```

**Desktop app:** add a computer and paste the `http://127.0.0.1:3774/pair#token=…` link.
**Web app:** run `pnpm web` (port 5733), set `web = "http://127.0.0.1:5733"` in the config, and open the
first link `pair` prints.

Then add a project on the **pi** computer, or start a thread without one. T3's first-run wizard lists only
Codex and Claude as agents; that's expected.

- Models and credentials come from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). None configured:
  `PI_DURABLE_T3_FAKE=1 pnpm start` uses an offline reply model.
- `pnpm start pair` works while the host is running; the code is single-use.

## Config

Optional: `~/.config/pi-durable-t3/config.toml` (`$XDG_CONFIG_HOME`). [`config.example.toml`](config.example.toml)
lists every key with its default. Most map straight onto `attachT3` options:

| Key | `attachT3` option |
|---|---|
| `listen` | `listen` |
| `web` | `webAppUrl` (and `pair` prints a link for it) |
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

`t3/` pairs with `durable.db`: back up and move them together. A file that doesn't parse stops the host with
a message naming it.

## Over Tailscale

Set `listen` to the machine's tailnet IP (no TLS; the tailnet is the boundary). If you serve the web app
over the tailnet too, point `web` at that URL.
