#!/bin/bash
set -euo pipefail

# MCP client launcher for the fmmcp-local stdio proxy.
# Wire MCP clients at this script.
# Usage mirrors the old gateway launcher:
#   launch-mcp.sh --env sandbox                        # gateway defaults to http://localhost:3020/mcp (dev-pod sidecar)
#   launch-mcp.sh --env next --gateway https://mcp-next.dev.fort.blue/mcp
#   launch-mcp.sh --env sandbox --scope-lock <name>    # needs scopeMap in ~/.fmcode/credentials.json
#
# Two launch modes, auto-detected by which build artifact sits alongside this
# script (UX-ROUND-2-PLAN.md W1 / T020):
#   - Packaged extension (dist-ext/cli.cjs present): the Saferoom .vsix ships
#     this script plus an esbuild-bundled, dependency-free CLI at
#     dist-ext/cli.cjs — plain `node`, no Yarn/PnP toolchain required, since
#     an installed extension has neither.
#   - Repo checkout (dist-ext/cli.cjs absent): falls back to the tsc build at
#     dist/local-mcp/cli.js via `yarn node`, which resolves this repo's Yarn
#     PnP dependency graph — the existing dev/CLI-parity path, unchanged.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f "dist-ext/cli.cjs" ]; then
  exec node dist-ext/cli.cjs "$@"
fi

exec yarn node dist/local-mcp/cli.js "$@"
