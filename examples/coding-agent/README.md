# Example: a coding agent in T3 Code

pi-durable's coding-agent recipe (`read`/`write`/`edit`/`bash`, a base prompt, models from your pi config)
with the bridge attached. It's the agent we test the bridge with, and a worked example of
[`attachT3`](../../README.md#attach-it-to-your-own-agent).

**It runs `bash` as your user, with no approvals**, in the project folders you add.

## Run it

From the repo root:

```sh
pnpm install
pnpm setup:t3     # fetch T3 at the pinned version: its contracts and its web app
pnpm start        # the agent on 127.0.0.1:3774, serving T3's web app
pnpm start pair   # a single-use pairing link (works while the host runs)
```

Open the link (`http://127.0.0.1:3774/pair#token=…`) in a browser: it signs the browser in and opens T3 with
the agent as "This machine". Add a project from the sidebar, or start a thread without one.

**Desktop app:** add a computer and paste the same link. The agent is then a second computer next to the
desktop's own: T3's first-run wizard lists only Codex and Claude, and Settings → Connections shows the
desktop's machine. Both are expected.

- Models and credentials come from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). None configured:
  `PI_DURABLE_T3_FAKE=1 pnpm start` uses an offline reply model.
- The web app comes from the repo's `web-dist/` (T3's own build, fetched by `setup:t3`). Without it, the host
  serves the API only.

## Subagents

The agent has a `subagent` tool (`src/subagent.ts`, installed in `src/host.ts`): pi-durable's foreground subagent
pattern. A call creates a child conversation owned by the call's task, runs `prompt` there on a copy of the parent's
agent without the tool (no recursion), and returns the child's answer. Stopping the parent stops the child. T3 shows the
call as a subagent card with a read-only child thread. The bridge keys on pi's convention (the call's `details` carry the
`conversationId` of a conversation its task owns), not on this tool's name.

## Config

Optional: `~/.config/pi-durable-t3/config.toml` (`$XDG_CONFIG_HOME`). [`config.example.toml`](config.example.toml)
lists every key with its default. Most map straight onto `attachT3` options:

| Key | `attachT3` option |
|---|---|
| `listen` | `listen` |
| `label` | `label` |
| `scratch_dir` | `scratchDir` |
| `token_ttl_days` | `tokenTtlSeconds` |
| `cors_origins` | `corsOrigins` |
| `tailscale_serve`, `tailscale_serve_port` | `tailscaleServe` (`{ port }`, 443 by default) |
| `instructions` | none: the agent's system prompt, added to every thread |

`--root <dir>` puts config and data in one directory instead of the XDG locations.

## Files

In `~/.local/share/pi-durable-t3/` (`$XDG_DATA_HOME`), or `<dir>` with `--root`:

| Path | What | Owner |
|---|---|---|
| `durable.db`, `models-store.json` | conversations, model choices | the agent (pi-durable) |
| `t3/` | `t3-settings.json`, `projects.json`, `auth.json`, `attachments/` | the bridge (`stateDir`) |
| `scratch/` | one folder per "No project" thread | agent work output |

`t3/` pairs with `durable.db`: back up and move them together. A file that doesn't parse stops the host with
a message naming it.

## Over Tailscale

Set `tailscale_serve = true` and restart. While the host runs it checks `tailscale serve status` and arms
`tailscale serve --https=<tailscale_serve_port> --bg http://127.0.0.1:<listen port>` only when that port is free (a
port already mapped to something else is refused with a warning — pick another `tailscale_serve_port`), and releases
its own mapping when you stop it gracefully — so the app is HTTPS on your tailnet, on the machine's MagicDNS name.
`pnpm start pair` prints the link for it (a browser opens it when the host serves the web app; the T3 desktop app
parses the same link pasted into Add computer):

```
https://<machine>.<tailnet>.ts.net/pair#token=…      # port 8443 shows as `:8443`
```

Open it on any device in the tailnet: it pairs the browser and opens the app. (The
plain-HTTP alternative: set `listen` to the machine's tailnet IP and open `http://<tailnet-ip>:3774/pair#token=…` —
the tailnet is then the only boundary, with no TLS.)
