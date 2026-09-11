import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { FortmesaServerSpec, ProjectorResult } from '../../shared/types.js';

/**
 * GitHub Copilot (VS Code) projector — USER-LEVEL configuration.
 *
 * Copilot's agent mode reads MCP servers from VS Code's own `mcp.json`. This
 * projector targets the USER-level file (the one VS Code exposes via the
 * "MCP: Open User Configuration" command), NOT the workspace
 * `.vscode/mcp.json`: configuring once should work in every workspace, and
 * writing into the user's repo is not this tool's business.
 *
 * TWO DIFFERENCES from the sibling projectors, both load-bearing:
 *
 * 1. The server map key is `servers`, NOT `mcpServers`. Claude/Cursor/Codex
 *    all use `mcpServers`; VS Code does not. Writing the wrong key produces a
 *    file that looks right and registers nothing.
 * 2. The path is platform-dependent (VS Code's user-profile folder), not a
 *    fixed `~/.<tool>` directory. See {@link vscodeUserDir}.
 *
 * Distinct from the existing `vscode` sync target, which live-registers via
 * the `vscode.lm` extension API from inside the extension host. That path
 * cannot work from the CLI, and it is not what Copilot reads from disk.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension. `COPILOT_USER_DIR` overrides the resolved directory for tests,
 * mirroring the sibling projectors' `CURSOR_HOME_DIR`/`CODEX_HOME_DIR`.
 */

const TARGET = 'copilot';
const RESTART_NOTE = 'run "MCP: List Servers" in VS Code (or restart it) to pick up this change';

/** The exact shape we write for our own entry — stdio, no `env`, no interpolation. */
interface CopilotServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * VS Code's user-profile directory, where `mcp.json` lives alongside
 * `settings.json`. Verified on Linux as `~/.config/Code/User`. The macOS and
 * Windows locations follow VS Code's documented per-platform user-data paths;
 * `COPILOT_USER_DIR` overrides all of it when the profile is non-default or
 * the install is portable.
 */
function vscodeUserDir(): string {
  const override = process.env.COPILOT_USER_DIR;
  if (override !== undefined && override !== '') return override;

  const home = homedir();
  const os = platform();
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  if (os === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User');
  // Everything else follows the XDG layout, which is where this was verified.
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code', 'User');
}

function copilotMcpJsonPath(): string {
  return join(vscodeUserDir(), 'mcp.json');
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCopilotServerEntry(value: unknown): value is CopilotServerEntry {
  if (!isJsonObject(value)) return false;
  if (typeof value.command !== 'string') return false;
  if (!Array.isArray(value.args)) return false;
  return value.args.every((arg) => typeof arg === 'string');
}

function entriesEqual(a: CopilotServerEntry, b: CopilotServerEntry): boolean {
  if (a.command !== b.command) return false;
  if (a.args.length !== b.args.length) return false;
  return a.args.every((value, index) => value === b.args[index]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the user `mcp.json` as a JSON object. Missing file or
 * unparseable/non-object content both default to `{}` — same discipline as
 * the sibling projectors.
 *
 * NOTE: VS Code tolerates comments in this file (JSONC). `JSON.parse` does
 * not, so a commented file is treated as blank and its comments are lost on
 * the next write. That is the same tradeoff the other projectors already
 * make, kept deliberately rather than pulling in a JSONC parser.
 */
async function readMcpJson(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return {};
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomically write the JSON object (tmp file + rename), 2-space indented with a trailing newline. */
async function writeMcpJson(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Detect whether VS Code is plausibly installed: either the user `mcp.json`
 * exists, or the user-profile directory does (VS Code creates it on first
 * run, long before any MCP server is configured).
 */
export async function detect(): Promise<boolean> {
  const [mcpJsonExists, dirExists] = await Promise.all([pathExists(copilotMcpJsonPath()), pathExists(vscodeUserDir())]);
  return mcpJsonExists || dirExists;
}

/**
 * Surgical merge of the user `mcp.json`: set or delete ONLY the
 * `servers.fortmesa` key. Every other top-level key and every other server
 * entry is preserved untouched.
 *
 * `enabled: false` actively removes our entry rather than merely skipping the
 * write, so flipping the toggle off cleans up a previous projection.
 */
export async function project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = copilotMcpJsonPath();

  try {
    const root = await readMcpJson(path);
    const servers = isJsonObject(root.servers) ? root.servers : {};
    const existingRaw = servers.fortmesa;

    if (enabled) {
      const desired: CopilotServerEntry = { command: spec.command, args: [...spec.args] };
      const existingEntry = isCopilotServerEntry(existingRaw) ? existingRaw : undefined;

      if (existingEntry !== undefined && entriesEqual(existingEntry, desired)) {
        return {
          target: TARGET,
          action: 'unchanged',
          detail: `"fortmesa" entry already up to date in ${path}`,
          restartNote: RESTART_NOTE,
        };
      }

      const action = existingRaw === undefined ? 'added' : 'updated';
      const nextRoot: Record<string, unknown> = { ...root, servers: { ...servers, fortmesa: desired } };
      await writeMcpJson(path, nextRoot);

      return {
        target: TARGET,
        action,
        detail: `${action === 'added' ? 'Added' : 'Updated'} "fortmesa" entry in ${path}`,
        restartNote: RESTART_NOTE,
      };
    }

    if (existingRaw === undefined) {
      const fileExists = await pathExists(path);
      return {
        target: TARGET,
        action: fileExists ? 'unchanged' : 'skipped',
        detail: fileExists
          ? `no "fortmesa" entry present in ${path}; nothing to remove`
          : `VS Code not detected on this machine (no ${path}); nothing to remove`,
        restartNote: RESTART_NOTE,
      };
    }

    const remainingServers = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== 'fortmesa'));
    const nextRoot: Record<string, unknown> = { ...root, servers: remainingServers };
    await writeMcpJson(path, nextRoot);

    return {
      target: TARGET,
      action: 'updated',
      detail: `Removed "fortmesa" entry from ${path}`,
      restartNote: RESTART_NOTE,
    };
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `failed to project into ${path}: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }
}
