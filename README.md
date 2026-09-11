# fmmcp-local — FortMesa MCP Local

> Client-side components for the FortMesa MCP architecture. The Cloud MCP
> Gateway (private `fmmcp-gw` repo) remains the single source of truth for all
> gateway tool schemas.

## Components

### Local MCP proxy (CLI) — implemented

A stdio MCP server that bridges IDE agents (Claude Code, Cursor, Codex,
Antigravity, VS Code, …) to the Cloud MCP Gateway over streamable HTTP with
your bearer token attached. Gateway tools are relayed with their schemas
**verbatim** (this repo holds zero gateway schemas). The three **documents
tools are served locally** — their download/upload use real paths on _your_
disk, which is exactly why they don't exist on the remote gateway surface.

Scope-lock enforcement lives here: the active environment, scope lock, and
per-environment gateway overrides are read from
[`~/.fmcode/config.json`](#configuration--fmcodeconfigjson) and enforced
against every scoped call, filtering locked `grc_scopes` list results too. A
running proxy watches that file and **hot-reloads** on change (new env,
gateway, or scope) without dropping the stdio pipe to your agent — see
`fmmcp-local switch` below.

### Saferoom VSIX — implemented (prototype)

A self-contained VS Code extension ("FortMesa Saferoom") providing the same
auth, environment switching, scope locking, IDE-sync, and (new) per-tool
enable/disable functionality as the CLI, through three tree views (Scopes,
Identity, Saferoom launcher) in its own activity-bar container plus a
"Settings" webview for everything else (Environment, Agents, Tools). No
workspace folder needs to be open — the extension bundles its own copy of
the local MCP. It reads and writes the exact same
`~/.fmcode/config.json` / `credentials.json` files as the CLI, so the two
stay in lockstep — switch environments from either one and the other picks it
up. See **[docs/VSIX.md](docs/VSIX.md)** if you'd rather drive FortMesa from a
UI than the command line.

## Quick start (CLI)

```bash
yarn install && yarn build
```

The canonical way an IDE launches the proxy is **flag-less** — `launch-mcp.sh`
takes no arguments; the active environment, gateway, and scope lock all come
from `~/.fmcode/config.json` (see below), so registering an IDE once and then
switching environments/scopes later never requires touching that IDE's config
again:

```bash
# Uses config.json's activeEnv/scopeLock as-is (defaults to env "sandbox",
# gateway http://localhost:3020/mcp, unlocked, on a fresh install)
yarn node dist/local-mcp/cli.js
```

For manual/one-off runs outside any IDE (local testing, debugging a specific
environment), CLI flags override config.json for that invocation only:

```bash
# Local dev pod (gateway sidecar on :3020, sandbox credentials)
yarn node dist/local-mcp/cli.js --env sandbox

# Against a deployed gateway
yarn node dist/local-mcp/cli.js --env next --gateway https://mcp-next.dev.fort.blue/mcp

# Scope-locked (names resolved via scopeMap in the credentials file, or a
# live gateway lookup + cache if a name isn't cached yet)
yarn node dist/local-mcp/cli.js --env prod --scope-lock varmed-management
```

Register with an MCP client like any stdio server — either let the CLI wire up
every IDE it detects on this machine in one shot:

```bash
yarn node dist/local-mcp/cli.js sync
```

or point a client at `launch-mcp.sh` directly, with no arguments:

```bash
claude mcp add-json fortmesa '{"command":"/workspaces/fmmcp-local/launch-mcp.sh","args":[]}'
```

## Management subcommands

Everything below reads/writes `~/.fmcode/config.json` and
`~/.fmcode/credentials.json` — the same files the Saferoom VSIX uses, so the
CLI and the extension are always in sync. None of these start the proxy; run
them with `yarn node dist/local-mcp/cli.js <subcommand> ...`.

| Subcommand                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :--------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                 | Prints `config.json`, the effective startup values (env/gateway/scope-lock after flag precedence), and whether a credential is present for the active env.                                                                                                                                                                                                                                                                                                                                                                               |
| `switch --env <name>`                    | Sets the active environment. Any running proxy hot-reloads onto it — no restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `switch --scope <name>[,<name>...]`      | Sets the scope lock: one name = `single` mode, more than one = `multi` (expert) mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `switch --unlock`                        | Explicitly disables the scope lock (all authorized scopes reachable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `token set <env> <token> [--base <url>]` | Stores a pasted API token for `<env>` in `credentials.json` (`--base` creates the env block if it doesn't exist yet).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scopes list [--env <name>]`             | Looks up scope name → scope ID via the live gateway, prints it, and caches it into `credentials.json`'s `scopeMap` (this is what makes `switch --scope <name>` and `--scope-lock <name>` work without repeating the lookup).                                                                                                                                                                                                                                                                                                             |
| `sync`                                   | Projects the canonical `fortmesa` MCP server entry into every detected, opted-in IDE (Claude Code, Cursor, Codex, Antigravity — VS Code registers itself live via the Saferoom extension instead of a file projector) and prints a per-target report with pick-up instructions (e.g. "restart session", "refresh /mcp").                                                                                                                                                                                                                 |
| `login [--env <name>] [--no-browser]`    | OAuth 2.0 code+PKCE sign-in: opens a browser and completes a local loopback callback, or (on a remote/SSH shell, or with `--no-browser`) prints the URL and reads the resulting code back from stdin. **Current status**: this command is fully implemented and correct, but the backend `appstoreAuth` client registration it depends on has not been created yet (separate, user-authorized ops work — VSIX-PLAN.md §8); until that lands it will fail at the token-exchange step with a clear error. Use `token set` in the meantime. |

Examples:

```bash
yarn node dist/local-mcp/cli.js status
yarn node dist/local-mcp/cli.js switch --env next
yarn node dist/local-mcp/cli.js switch --scope barsoommsp
yarn node dist/local-mcp/cli.js switch --scope barsoommsp,aws-test   # expert multi-scope
yarn node dist/local-mcp/cli.js switch --unlock
yarn node dist/local-mcp/cli.js token set sandbox eyJhbGciOi... --base http://localhost:3010
yarn node dist/local-mcp/cli.js scopes list --env sandbox
yarn node dist/local-mcp/cli.js sync
yarn node dist/local-mcp/cli.js login --env sandbox --no-browser
```

## Configuration — `~/.fmcode/config.json`

The canonical registry shared by the CLI, the Saferoom VSIX, and every running
proxy instance: which environment is active, the scope lock, per-environment
gateway URL overrides, per-IDE sync opt-outs, and log level. It's created
automatically with built-in defaults the first time anything reads it (e.g.
the first `status` call); you don't need to hand-write it, though you can —
edits are picked up live by any running proxy.

```jsonc
{
  "version": 1,
  "activeEnv": "sandbox",
  "scopeLock": { "mode": "single", "scopes": ["barsoommsp"] }, // mode: single | multi | unlocked
  "environments": {
    "sandbox": { "gateway": "http://localhost:3020/mcp" },
    "next": { "gateway": "https://mcp-next.dev.fort.blue/mcp" },
    "prod": { "gateway": "https://mcp.fortmesa.com/mcp" },
  },
  "ideSync": { "claude": true, "vscode": true, "cursor": true, "codex": true, "antigravity": true },
  "logLevel": "info",
}
```

**Precedence at proxy startup**: explicit CLI flags (`--env`/`--gateway`/`--scope-lock`)
override `config.json`, which overrides the built-in defaults shown above.
Once the proxy is running, only `config.json` drives reloads — flags are
consulted at startup only, so `switch`/the Saferoom UI are the way to change a
live session.

Every key here is also exposed as a `fortmesa.*` VS Code setting when you use
the Saferoom extension, and the two stay reconciled automatically. For the
full knob-by-knob mapping (`config.json` key ↔ VS Code setting ↔ CLI
flag/command ↔ Saferoom UI control), see
**[docs/CONFIG-REFERENCE.md](docs/CONFIG-REFERENCE.md)**.

## Credentials — `~/.fmcode/credentials.json`

Resolved by the TokenProvider chain (AWS CLI model, v1 subset):

1. `FORTMESA_API_TOKEN` (+ optional `FORTMESA_API_BASE`) environment variables
2. `~/.fmcode/credentials.json` — multi-env format, block selected by
   `--env`/`config.json`'s `activeEnv`

The bearer is attached to every gateway request; the same credentials drive the
local documents tools' direct API calls. Tokens must be FortMesa **API (M2M)
tokens** — the v2 API does not accept browser session tokens.

You don't need to hand-edit this file: `token set` and `login` (and their
Saferoom VSIX equivalents — the Signed-in user pane's **Sign in** button and
its **Advanced: paste an access token** control) all write to it for you, atomically and with `0600` permissions. Scope-name
resolution (`scopes list`, or the first use of a not-yet-cached
`--scope-lock`/`switch --scope` name) also caches into this file's per-env
`scopeMap`, so subsequent lookups are gateway-free.

## Testing

```bash
# Full chain: runner ↔ [stdio] ↔ proxy ↔ [HTTP+bearer] ↔ gateway (:3021) ↔ API
yarn node scripts/test-runner.mjs --env sandbox

# Config-driven hot-reload: boot flag-less, mutate config.json, assert
# tools/list_changed + scope-lock enforcement flips without dropping the pipe
yarn node scripts/hot-reload-test.mjs
```

Requires `/workspaces/fmmcp-gw` built (`yarn build` there) and valid `sandbox`
credentials. Expected: 16 tools (13 proxied + 3 local documents), ~90 tests.

## Project Structure

```
src/local-mcp/
├── cli.ts                  # entry: proxy startup, hot-reload wiring, and all management subcommands
├── proxy.ts                # stdio server ↔ gateway HTTP client, incl. in-process reload()
├── auth/token-provider.ts  # env → ~/.fmcode/credentials.json
└── tools/
    ├── registry.ts         # captures registerTool() calls; Zod → JSON Schema
    └── documents.ts        # migrated from fmmcp-gw (path-based file I/O)
src/registry/                # canonical config + IDE projection layer — shared by the CLI and the extension; never imports "vscode"
├── config.ts                # ~/.fmcode/config.json schema, load/save/watch, flag precedence
├── credentials.ts           # ~/.fmcode/credentials.json read/write (shared by CLI + extension auth commands)
├── scope-resolve.ts         # scope name -> scopeId resolution + scopeMap caching
├── sync.ts                  # drives the file-based IDE projectors below
├── oauth-flow.ts / pkce.ts  # OAuth 2.0 code+PKCE login (loopback + paste-code paths)
└── projectors/               # claude.ts, cursor.ts, codex.ts, antigravity.ts — one canonical `fortmesa` server entry, surgically merged
src/extension/                # Saferoom VSIX — the UI shell over registry + engine; the only code allowed to import "vscode"
src/shared/                   # copies from fmmcp-gw (see .agent/DECISIONS.md D005)
launch-mcp.sh                 # the stable, args-free entrypoint every IDE config points at
```

## License

Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text and
[NOTICE](NOTICE) for copyright and trademark attribution. Bundled
third-party dependencies are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (generated — see
`scripts/release/generate-third-party-notices.mjs`). Contribution
guidelines, including the required sign-off, are in
[CONTRIBUTING.md](CONTRIBUTING.md).
