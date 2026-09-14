# FortMesa Saferoom

**Your security program, in the editor you already work in — without handing your files to anyone.**

FortMesa Saferoom is the local MCP server and VS Code extension for
[FortMesa](https://fortmesa.com/). It runs on your machine, beside your coding
agent, and gives that agent a scoped door into your FortMesa GRC data:
controls, assets, vulnerabilities, tasks, and documents.

You sign in once. You choose which security scopes the agent may touch, and
which tools it may call. Those choices are enforced here, on your machine — not
on the far side of a network hop where you would have to take them on trust.

## What it lets you do

**Ask your agent about your program.** Saferoom registers a `fortmesa`
MCP server with Claude Code, VS Code, Cursor and other MCP clients, so any of
them can read and update FortMesa directly, in the conversation you are already
having.

**Your documents stay on your disk.** Document tools run inside Saferoom, so
a download writes a real file to a path you name and an upload reads one from
your workspace — no signed links to juggle, no bytes through anyone else's
hands. If you would rather your agent move the bytes itself, switch Documents to
Network mode and the gateway's link-based tools take their place.

**Fence the blast radius.** Lock the agent to one scope, to a named set, or
leave it open to everything you are entitled to. Turn any tool off and it
disappears from the agent's tool list — and is refused if the agent asks for it
by name anyway.

**Point it at the FortMesa that is yours.** Saferoom talks to FortMesa
production out of the box. If your organisation runs its own gateway, add it
under **Data region ▸ Add server**, name it, and select it — no config file to
hand-edit, and it stays available in production builds.

**Change your mind without restarting anything.** Switch environment, scope, or
tool selection and every connected agent picks it up straight away. The status
bar always says where you stand: `Not signed-in`, the scope's own name,
`Connected · no scopes`, or `Connected`.

**See what your agent is doing, while it does it.** The Event viewer at the top
of the FortMesa sidebar is a live timeline of everything passing through
Saferoom — tool calls, local and relayed alike, plus sign-in, token refresh and
expiry, and gateway connects. Each entry appears the moment work starts and updates
in place when it finishes: `✓ documents · upload_url  120ms  now`. The
expand icon opens a fullscreen view with the last 200 events, the scope each
call ran in, and whether it was served locally or relayed.

**The timeline records the tool, the scope, the outcome and how long it took —
and deliberately nothing else.** No request or response payloads, no file paths,
no document titles, no email addresses, no tokens, no raw error text. Those are
not filtered out before display; they are never collected. Nothing is written to
disk either: the timeline lives in memory for the life of the editor window, and
closing the window leaves no trace of it behind.

## How it works

Your agent starts Saferoom on your machine. Saferoom connects onward to the
FortMesa MCP gateway at `https://mcp.fortmesa.com/mcp` over HTTPS with your
bearer token attached — allow that host if your network filters outbound
traffic.

Gateway tools are relayed to your agent exactly as the gateway describes them,
so Saferoom never presents an altered version of a tool — and it keeps serving
the last list it was given, so a brief gateway outage does not make your agent's
tools disappear mid-task. Document tools are the exception: the gateway has no
filesystem, so in the default Local-file mode Saferoom answers those itself. Your scope lock is
applied here too — on every scoped call and on the results of scope listings,
before the request leaves your machine.

The extension and the CLI share `~/.fmcode/config.json` and
`~/.fmcode/credentials.json`, so a change made in either is picked up by the
other and by every running agent.

## Install

Each release publishes the extension to **Open VSX** and attaches three
artifacts to its [GitHub Release](https://github.com/fortmesa/fmmcp-local/releases):

| Artifact                           | For                                                                                                     |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `FortMesa-Saferoom-<version>.vsix` | VS Code, Cursor — install from Open VSX, or sideload the file (self-contained: no repo checkout needed) |
| `FortMesa-Saferoom-<version>.mcpb` | Claude Desktop and other MCP Bundle hosts                                                               |
| `fmmcp-local-<version>.tgz`        | The CLI on its own (`fmmcp-local`)                                                                      |

Then open the **FortMesa Saferoom** view in the activity bar and choose **Sign
In**. Sign-in is OAuth 2.0 with PKCE against FortMesa's identity provider, and
your token is written to `~/.fmcode/credentials.json` with `0600` permissions
and never leaves the machine.

## Settings

Every `fortmesa.*` VS Code setting has a matching `config.json` key. Edit either
one, or use the Saferoom UI — they are the same setting.

| Setting                                                                  | What it does                                                                                                                    | Values                              | Default                 |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------- | :---------------------- |
| `fortmesa.activeEnv`                                                     | The active FortMesa environment; switching re-targets the MCP server for every synced IDE                                       | environment name                    | `prod`                  |
| `fortmesa.environments`                                                  | Environments Saferoom can target, including servers you add yourself                                                            | map of env name → `{ gateway }`     | production gateway only |
| `fortmesa.scopeLock.mode`                                                | How the accessible-scope set is expressed                                                                                       | `single` / `multi` / `unlocked`     | `unlocked`              |
| `fortmesa.scopeLock.scopes`                                              | The accessible scope name(s); ignored when `mode` is `unlocked`                                                                 | array of scope names                | `[]`                    |
| `fortmesa.disabledTools`                                                 | Tool names hidden from the agent's tool list and refused on a direct call                                                       | array of tool names                 | `[]`                    |
| `fortmesa.documentsMode`                                                 | Which document tools are exposed: `local` reads and writes your disk, `network` exposes the gateway's signed-link tools instead | `local` / `network`                 | `local`                 |
| `fortmesa.ideSync.<claude\|vscode\|cursor\|codex\|antigravity\|copilot>` | Keep the `fortmesa` MCP server registration synced to that IDE                                                                  | boolean                             | `true`                  |
| `fortmesa.logLevel`                                                      | Log verbosity for the extension's output channel and the local MCP server                                                       | `debug` / `info` / `warn` / `error` | `info`                  |

`~/.fmcode/config.json` and `~/.fmcode/credentials.json` (`0600`) are
machine-scoped on purpose — Settings Sync never carries them to another host.

## Requirements

- Node.js **≥ 24**
- VS Code **≥ 1.102** (for the extension)
- A FortMesa account

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines, including the
  required sign-off
- [LICENSE](LICENSE) and [NOTICE](NOTICE) — licensing and attribution
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — bundled third-party
  dependencies

Questions, bugs, and feature requests:
[github.com/fortmesa/fmmcp-local/issues](https://github.com/fortmesa/fmmcp-local/issues).
More about FortMesa at [fortmesa.com](https://fortmesa.com/).

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE) for the full text and
[NOTICE](NOTICE) for copyright and trademark attribution. Bundled third-party
dependencies are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

<sub>This repository is the public mirror of FortMesa's internal development
repository; releases are published here as snapshots.</sub>
