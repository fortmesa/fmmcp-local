import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FortmesaServerSpec, ProjectorResult } from '../../shared/types.js';

/**
 * Antigravity IDE projector (VSIX-PLAN.md §3.3 row 5; curriculum
 * 04-ide-integration-matrix.md §5; pitfall 08-pitfalls-log.md #12).
 *
 * FILE-ONLY target — Antigravity exposes no extension/registration API, so
 * this module surgically merges the single `mcpServers.fortmesa` key into
 * `~/.gemini/config/mcp_config.json` and leaves everything else in that file
 * byte-identical. Config-file edits do not hot-apply in Antigravity; every
 * `ProjectorResult` carries a `restartNote` telling the user to hit Refresh,
 * run a `/mcp` manager reload, or restart the IDE.
 *
 * Opt-out semantics differ from every other Phase P1 projector: Antigravity
 * has its own in-file `"disabled": true` boolean, so `project(spec, false)`
 * sets that flag rather than deleting the `fortmesa` entry (deleting is what
 * claude/cursor/codex projectors do instead — see their sibling modules).
 *
 * NOTE (08-pitfalls-log #12 / curriculum 04 §5): this pod's real
 * `~/.gemini/config/mcp_config.json` already carries hand-written
 * `fortmesa-sandbox` / `fortmesa-next` entries from earlier manual wiring.
 * This module MUST coexist with them — it only ever reads/writes the single
 * `"fortmesa"` key and never touches `fortmesa-sandbox`/`fortmesa-next` or any
 * other key. A later, separate manual cleanup step consolidates those legacy
 * entries; that is explicitly out of scope here.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (mirrors src/registry/config.ts and src/registry/scope-resolve.ts,
 * including their `*_DIR` env-var override convention for tests, here
 * `GEMINI_HOME_DIR`).
 */

const TARGET = 'antigravity';

const RESTART_NOTE =
  'use the Installed MCP Servers Refresh button, or the /mcp manager reload, or restart the IDE — Antigravity does not auto-detect config file changes';

/** Resolve the Antigravity home directory. `GEMINI_HOME_DIR` overrides `~/.gemini` for tests. */
function geminiDir(): string {
  return process.env.GEMINI_HOME_DIR ?? join(homedir(), '.gemini');
}

/** Absolute path to the Antigravity MCP config file under the (possibly overridden) home dir. */
function geminiConfigPath(): string {
  return join(geminiDir(), 'config', 'mcp_config.json');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Detect whether Antigravity is present on this machine: either it has
 * already been configured for MCP (the config file exists) or the `~/.gemini`
 * home directory exists at all (curriculum 04 §5 — no CLI/binary probe exists
 * for this target).
 */
export async function detect(): Promise<boolean> {
  if (await pathExists(geminiConfigPath())) {
    return true;
  }
  return pathExists(geminiDir());
}

/**
 * Read `mcp_config.json` as a loosely-typed JSON object (NOT schema-validated
 * away to a known shape) — every top-level key besides the one this module
 * manages (`mcpServers.fortmesa`) must round-trip untouched, including keys
 * unknown to this module. A missing file is treated as `{}` (the surrounding
 * `~/.gemini` directory may exist without ever having an MCP config yet).
 */
async function readMcpConfigFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Antigravity MCP config at ${path}: expected a JSON object at the top level`);
  }
  return parsed;
}

/** Atomic write (tmp + rename, matching src/registry/config.ts's saveConfig) so a concurrent reader never sees a half-written file. */
async function writeMcpConfigFile(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Structural equality between an existing (unknown-shaped) `mcpServers.fortmesa`
 * value and the entry `project()` is about to write — used to report
 * `'unchanged'` and skip the write entirely rather than touching the file's
 * mtime for a no-op. Requires an exact key-set match (so a stray leftover key
 * from a prior manual edit, e.g. an `env` block, correctly counts as a
 * difference) plus matching `command`/`args`/`disabled`.
 */
function entryMatches(existing: unknown, desired: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(existing)) return false;

  const existingKeys = Object.keys(existing).sort();
  const desiredKeys = Object.keys(desired).sort();
  if (existingKeys.length !== desiredKeys.length) return false;
  if (!existingKeys.every((key, index) => key === desiredKeys[index])) return false;

  if (existing.command !== desired.command) return false;

  const existingArgs = existing.args;
  const desiredArgs = desired.args;
  if (!Array.isArray(existingArgs) || !Array.isArray(desiredArgs)) return false;
  if (existingArgs.length !== desiredArgs.length) return false;
  if (!existingArgs.every((value, index) => value === desiredArgs[index])) return false;

  if ('disabled' in desired && existing.disabled !== desired.disabled) return false;

  return true;
}

/**
 * Project (or opt-out) the canonical `fortmesa` MCP server entry into
 * `~/.gemini/config/mcp_config.json`.
 *
 * `enabled=true`: writes `mcpServers.fortmesa = { command, args }` — a full
 * replace, which is how a stale `"disabled": true` from a prior opt-out (or
 * any other stray key from a manual edit) gets cleared on re-enable.
 *
 * `enabled=false`: does NOT delete the entry — it sets
 * `mcpServers.fortmesa = { command, args, disabled: true }` (creating the
 * entry if absent), since Antigravity represents "off" as an in-file boolean
 * rather than an absent key (curriculum 04 §5). This is the one Phase P1
 * target that opts out this way instead of deleting.
 *
 * Every other top-level key (including unrelated `mcpServers` entries such as
 * this pod's hand-written `fortmesa-sandbox`/`fortmesa-next`) is preserved
 * untouched — this function only ever reads and reassigns the single
 * `mcpServers.fortmesa` key.
 */
export async function project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = geminiConfigPath();

  let fileData: Record<string, unknown>;
  try {
    fileData = await readMcpConfigFile(path);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `Failed to read/parse ${path}: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }

  const existingMcpServers = fileData.mcpServers;
  const mcpServers = isRecord(existingMcpServers) ? { ...existingMcpServers } : {};

  const desiredEntry: Record<string, unknown> = enabled
    ? { command: spec.command, args: [...spec.args] }
    : { command: spec.command, args: [...spec.args], disabled: true };

  const existingEntry = mcpServers.fortmesa;
  const existed = existingEntry !== undefined;

  if (existed && entryMatches(existingEntry, desiredEntry)) {
    return {
      target: TARGET,
      action: 'unchanged',
      detail: `"fortmesa" entry in ${path} is already ${enabled ? 'enabled' : 'disabled'} with the canonical spec — no write performed.`,
      restartNote: RESTART_NOTE,
    };
  }

  if (!enabled && !existed) {
    if (!(await detect())) {
      return {
        target: TARGET,
        action: 'skipped',
        detail: `Antigravity not detected on this machine (no ${path}, no ${geminiDir()}); nothing to remove`,
        restartNote: RESTART_NOTE,
      };
    }
    // else: detect() is true (e.g. the config file or ~/.gemini dir exists,
    // just with no "fortmesa" key yet) — fall through to the existing write
    // path below, which still creates the disabled:true entry. This is
    // intentional: an existing config file/entry means Antigravity IS
    // present, and this behavior is preserved from before this fix.
  }

  mcpServers.fortmesa = desiredEntry;
  fileData.mcpServers = mcpServers;

  try {
    await writeMcpConfigFile(path, fileData);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `Failed to write ${path}: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }

  const action = existed ? 'updated' : 'added';
  const detail = enabled
    ? `Wrote "fortmesa" -> { command: "${spec.command}", args: [] } in ${path}.`
    : `Set "fortmesa".disabled = true in ${path} (entry preserved, not deleted).`;

  return { target: TARGET, action, detail, restartNote: RESTART_NOTE };
}
