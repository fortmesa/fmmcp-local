# AI Agent Context — fmmcp-local

> **File Role**: Navigation and reference file for the fmmcp-local repository.

**Repository**: `fortmesa/fmmcp-local`
**Role**: Client-side FortMesa MCP — Saferoom VSIX + Local MCP Proxy

## Vision

See [VISION.md](../fmmcp-gw/VISION.md) in the `fmmcp-gw` repo (private) for the full architecture vision, component inventory, and design decisions.

**This repo covers:**

- **Saferoom VSIX** — VS Code extension for Tenant Scope switching + OAuth JWT acquisition
- **Local MCP ("The Dumb Proxy")** — stdio↔httpstream bridge, zero schemas, JWT from OS Keychain

**Counterpart repo:** `fmmcp-gw` (Cloud MCP Gateway — private, server-side)

**Naming convention (D015)**: this repo, the CLI command, and "the local MCP
proxy" as a concept are always called **`fmmcp-local`** — in the terminal, in
code comments, in doc prose. The VS Code extension itself (a sub-part of this
repo, `src/extension/**`) has its own identity, **`fortmesa.saferoom`**
(`package.json`'s `name: "saferoom"`) — call it **Saferoom** whenever you're
referring to the thing as it appears inside the IDE (panels, webview, status
bar, command palette). `package.json`'s `"bin"` is the explicit object form
`{ "fmmcp-local": "dist/local-mcp/cli.js" }` specifically so the CLI command
name stays `fmmcp-local` independent of the extension's own package name.

## Project Structure

```
fmmcp-local/
├── AGENTS.md               # This file — agent navigation
├── SECURITY.md             # Cross-cutting security architecture
├── SPECS.md                # Technical specification
├── ERRATA.md               # Known issues
├── TODOS.md                # Roadmap / task items
├── BURNDOWN-*.md           # Issue tracking (Inbox, Open, Decisions, Archive)
├── .agent/
│   ├── DECISIONS.md        # User decisions recorded by agent
│   ├── INTERVIEW.md        # Current active question / decision point
│   ├── JOURNAL-NOTES.md    # Curated knowledge base
│   └── JOURNAL-STREAM.md   # Blind-write inbox for new learnings
└── src/
    ├── extension/          # Saferoom VSIX — VS Code extension shell (activation, 3 TreeViews + the "Saferoom Settings" webview, commands, settings↔config.json sync); the ONLY tree allowed to `import 'vscode'`
    ├── local-mcp/          # Local MCP proxy (stdio ↔ httpstream)
    ├── registry/           # Canonical ~/.fmcode/config.json (schema, hot-reload) + per-IDE projectors (Claude/Cursor/Codex/Antigravity); shared by the CLI and the VSIX — NEVER imports `vscode`
    └── shared/             # Shared types, auth utilities
```

**Build outputs** (all git-ignored; the three release artifacts go to the releases page, never into the repo):

| Path        | Produced by                                                                                                                                           | Consumed by                                                                                                                                                            |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/`     | `yarn build` (`tsc`, PnP)                                                                                                                             | `package.json`'s `bin` (`dist/local-mcp/cli.js`) — CLI, unchanged pipeline                                                                                             |
| `dist-ext/` | `yarn build:ext` (`esbuild` bundle, CJS, extension host) + `yarn build:cli` (`esbuild` bundle, CJS, dependency-free CLI/proxy)                        | `package.json`'s `main` (`dist-ext/extension.cjs`); `dist-ext/cli.cjs` is what the bundled `launch-mcp.sh` runs inside the packaged `.vsix` (no Yarn/PnP needed there) |
| `*.vsix`    | `yarn package:ext:prod` for anything published; plain `yarn package:ext` builds the same thing with all four environments, for local sideloading only | Releases come from GitHub, always prod, built from `main`. Sideload a dev build with `code --install-extension`. Never committed                                       |
| `*.mcpb`    | `yarn package:mcpb`, and `package:ext` runs it too                                                                                                    | MCP Bundle for Claude Desktop and other MCPB hosts. Ships on the releases page                                                                                         |
| `*.tgz`     | `yarn pack`, from the pipeline's package step                                                                                                         | The npm-publishable CLI tarball. Ships on the releases page                                                                                                            |

The extension bundle's file extension must stay `.cjs`, never `.js` — see
`.agent/DECISIONS.md` D011.

### The MCP Bundle (`.mcpb`)

`yarn package:mcpb` writes `FortMesa-Saferoom-<version>.mcpb`, a zip holding a
`manifest.json` plus the server, which Claude Desktop and other MCPB hosts
install in one step. Format: github.com/modelcontextprotocol/mcpb. Required
manifest fields are `manifest_version`, `name`, `version`, `description`,
`author`, `server`.

#### How a bundled server authenticates

**The host never runs OAuth for it.** MCP authorization is an HTTP-transport
feature; the spec tells STDIO implementations to take credentials from the
environment instead, and an MCPB server is stdio-spawned by definition. There
is no hook for delegating CIMD to Claude Desktop.

**So the bundle runs CIMD itself.** `FMCODE_AUTO_LOGIN=true`, set only in the
manifest, makes the proxy open a browser and complete the same PKCE flow the
`login` subcommand uses when it finds no stored credentials. It writes
`~/.fmcode/credentials.json` and carries on, and the refresh token stored with
it keeps the session alive. The manifest asks the user for an environment, not
for a pasted token.

Keep that env var out of every other launch path. A proxy started from a shell
or an IDE must never pop a browser on its own.

**Nothing on this path may touch stdout.** Stdout is the JSON-RPC channel and
stdin is the client's half of it, so the sign-in can neither print nor prompt.
`registry/login-flow.ts` exists to share the PKCE exchange between the two
callers while each supplies its own `notify`: stdout for the terminal
subcommand, stderr for the proxy. The paste-code fallback is unavailable in
the bundle for the same reason, since it reads stdin. The smoke test asserts
stdout stays empty.

#### Bundle mechanics

**The payload is `dist-ext/cli.cjs`, not `dist/local-mcp/cli.js`.** The former
is a self-contained esbuild bundle, so the archive needs no `node_modules` and
comes to four files. The latter needs its thirty-odd sibling modules and a
resolver.

**The archive ships a minimal `package.json`.** Not decoration:
`src/shared/version.ts` reads `<__dirname>/../package.json` at MODULE LOAD to
resolve `VERSION`, and `__dirname` is `server/` inside an installed bundle.
Without it the server throws ENOENT before serving anything.

**`scripts/build-mcpb.mjs` extracts the bundle and runs it three ways before
declaring success**: unconfigured (must fail on credentials), with a token in
the environment (must reach the gateway step), and with `FMCODE_AUTO_LOGIN`
(must start CIMD sign-in, log the URL to stderr, and leave stdout empty).
`FMCODE_NO_BROWSER` and `FMCODE_LOGIN_TIMEOUT_MS` keep that third run from
opening a window or waiting out the real redirect timeout.

Do not weaken this test. Its first version ran `--help`, which proved only
that the module graph loads: it passed, and the bundle it blessed exited
instantly on a real install. A smoke test that cannot fail the way the product
fails is not a smoke test.

**`.mcpb` is excluded from the VSIX and the npm tarball** (`.vscodeignore`,
and `.npmignore`'s allowlist), the same way `*.tgz` already is. vsce excludes
only its own `*.vsix` by default.

The bundle inherits the prod-only strip for free, because it wraps a
`dist-ext/cli.cjs` that was already built with the define.
`package:ext:prod` builds and verifies it alongside the other two.

### Prod-only builds (`FORTMESA_PROD_ONLY`)

`yarn package:ext:prod` builds all three release artifacts, VSIX, npm tarball
and `.mcpb`, carrying prod alone. The sandbox, next, and latest hostnames are absent from
every shipped file, and no other environment is selectable. The flag is **off
by default**; a normal `yarn package:ext` is unchanged and still ships all
four.

Every published artifact is production: npmjs, the marketplace VSIX, and any
`.mcpb` bundle added later. All of them go through this path.

Five surfaces carry non-prod hostnames, and each needs different handling:

| Surface                         | Mechanism                                                                                                                                                                                                                                                                                  |
| :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist-ext/**` bundles           | esbuild `--define:__FORTMESA_PROD_ONLY__=true`. The guarded expressions in `src/registry/environments.ts` fold and dead-code elimination drops `DEV_ENVIRONMENTS`.                                                                                                                         |
| `dist/registry/environments.js` | `tsc` applies no define and no elimination, so the emitted file is re-run through `esbuild --bundle --minify-syntax`. Measured: `--minify-syntax` alone leaves every URL in place, because esbuild only tree-shakes when bundling. Bundling this file is a no-op since it imports nothing. |
| Other `dist/**` modules         | They hold the hostnames only in doc comments, which still ship. A plain esbuild transform drops comments and leaves the import graph alone, which the unbundled npm tarball needs.                                                                                                         |
| `package.json`                  | vsce copies it in verbatim. `scripts/package-prod.mjs` rewrites `fortmesa.environments` and `fortmesa.activeEnv`, then restores the original.                                                                                                                                              |
| Shipped text                    | `launch-mcp.sh`, `README.md`, `CHANGELOG.md`, `docs/**` all shipped `dev.fort.blue` examples. `scripts/prod-scrub.mjs` rewrites those URLs to their prod equivalents and drops any line still matching.                                                                                    |

Sourcemaps and declarations are **deleted**, not scrubbed. An esbuild `.map`
embeds the full original source, so a prod bundle's map hands back every
hostname the bundle just removed, and `tsc` copies doc comments into `.d.ts`.
Neither is needed at runtime and the package declares no `types` entry.

**Two verifiers, and the second one is the authority.**
`yarn verify:prod-strip` greps the build trees before packaging, as a fast
fail. `scripts/verify-prod-artifacts.mjs` then opens the built `.vsix`, `.tgz` and
`.mcpb` and greps every entry inside them, reading them with
`scripts/archive.mjs` rather than `unzip`/`tar`, which the offline `node:24`
CI image is not guaranteed to carry. Keep both. Checking build trees is
not the same as checking what ships: an earlier version of this flag verified
`dist/` and `dist-ext/`, passed, and produced a VSIX containing
`launch-mcp.sh`, `README.md`, and two docs that all named internal hostnames.
If `unzip` or `tar` is missing, the artifact verifier FAILS rather than
skipping. A verifier that passes without reading the archive is worse than
none.

When adding a guarded expression, repeat the full
`typeof __FORTMESA_PROD_ONLY__ === 'boolean' && __FORTMESA_PROD_ONLY__` test
inline. Reading the flag through a shared `const` leaves the fold dependent on
constant propagation, and elimination is no longer guaranteed. The `typeof` is
what keeps the source valid under plain `tsc`, where nothing defines the
identifier.

Selectability is separate from stripping. `isSelectableEnv()` gates the
environment picker (`switchers.ts`) and startup resolution
(`resolveEffectiveStartup`), so a `config.json` left over from an earlier
install cannot put a next entry back in the list or smuggle one in through
`--env`. A normal build still accepts any environment, including a custom
gateway.

### Release artifacts (agents MUST follow)

**Nothing built is committed.** This repo uses no Git LFS. The `.vsix`,
`.tgz`, and `.mcpb` are git-ignored and go out through the releases page, so
version control holds only the source they are built from.

Build them after the quality gate, never before. `yarn test` is that gate now,
and it chains format check, lint, a clean rebuild and every suite, so run it
and only then `yarn package:ext` (or `yarn package:ext:prod` for a prod-only
release).

> ⚠️ **`yarn package:ext` is a DEV build. It is not shippable.** It ships every
> environment's hostnames and full sourcemaps by design, and `--sourcemap`
> embeds the original source. **`yarn package:ext:prod` is the only release
> path.** This used to be a silent trap (security delta F-5, 2026-09-04):
> `package:ext` ran `verify:prod-strip` without setting `FORTMESA_PROD_ONLY`,
> and the verifier answered with a passing-looking "nothing to verify" line — so
> a release cut with the shorter, more obvious command got none of the
> protection and was told nothing was wrong. The verifier now **exits non-zero**
> when the flag is unset, and `package:ext` passes `FORTMESA_PROD_ONLY=false`
> explicitly so it prints a loud NOT-A-RELEASE-ARTIFACT banner instead. The
> default script deliberately did NOT change to the prod path — which script is
> the default is a release-process decision, not a security fix's to make. Never publish an artifact built from unlinted or
> untested source. Lint here is strict (`eslint . --max-warnings 0`,
> typescript-eslint `strictTypeChecked` plus `eslint-plugin-secure-coding`,
> `no-explicit-any: error`), and the `lint-staged` pre-commit hook holds staged
> TypeScript to the same rules.

The pipeline's package step collects `*.vsix`, `*.tgz`, and `*.mcpb`. It does
not publish. Choosing the distribution channel is a separate change, still
open in `DISTRIBUTION.md`.

## Repository Knowledge Base

The `.agent/` directory is this repo's knowledge base:

| File                | Purpose                                                                                     |
| :------------------ | :------------------------------------------------------------------------------------------ |
| `DECISIONS.md`      | Architectural and design decisions made during development                                  |
| `INTERVIEW.md`      | The current active question or choice being presented to the user — a moving eye, not a log |
| `JOURNAL-NOTES.md`  | Curated learnings, anti-patterns, and gotchas                                               |
| `JOURNAL-STREAM.md` | Unprocessed entries — triage into JOURNAL-NOTES or discard                                  |

## Governance Files

| File            | Workflow    | Purpose                                  |
| :-------------- | :---------- | :--------------------------------------- |
| `TODOS.md`      | `/todos`    | Roadmap items and enhancements           |
| `ERRATA.md`     | `/errata`   | Known bugs and issues                    |
| `BURNDOWN-*.md` | `/burndown` | Systematic issue tracking and resolution |

## Key Constraints

- **Visibility**: This repo may become public for transparency — no secrets, no server-side logic
- **Zero Schemas**: The Local MCP holds no tool schemas — it is a pure JWT-authenticated proxy
- **Package Manager**: Yarn Berry (per workspace standard)
