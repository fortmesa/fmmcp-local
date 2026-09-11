import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FortmesaServerSpec, ProjectorResult } from '../../shared/types.js';

/**
 * Cursor IDE projector (VSIX-PLAN.md §3.3 row 3; curriculum 04 §3).
 *
 * FILE-ONLY. Cursor's proprietary live-registration API
 * (`vscode.cursor.mcp.registerServer` / `unregisterServer`) is a VS Code
 * *extension host* API — it cannot be called from a plain Node process, so it
 * does not belong here. That runtime path is Phase P2's job, inside
 * `src/extension/**`, for the case where the Saferoom extension happens to be
 * running inside Cursor itself. This module is the file-based fallback used
 * by (a) the CLI (`fmmcp-local sync`), which never runs inside an extension
 * host, and (b) the extension itself when it is *not* running inside Cursor.
 *
 * Target file: `~/.cursor/mcp.json`, top-level `mcpServers` map, classic
 * shape (`{ command, args }`). Cursor supports `${env:NAME}`-style
 * interpolation in that file — we never emit it; the registry only ever
 * writes plain literal strings (curriculum 04 cross-cutting rule #2).
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (mirrors src/registry/config.ts and src/registry/scope-resolve.ts).
 *
 * Home directory is overridable via `CURSOR_HOME_DIR` for tests (mirrors
 * sibling projectors' `CLAUDE_HOME_DIR`/`CODEX_HOME_DIR`/`GEMINI_HOME_DIR`).
 */

const TARGET = 'cursor';
const RESTART_NOTE = "open Cursor's MCP settings panel and click Refresh (or restart Cursor) to pick up this change";

/** The exact shape we write for our own entry — no `env`, no interpolation. */
interface CursorServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/** Resolve the Cursor home directory. `CURSOR_HOME_DIR` overrides `~/.cursor` for tests. */
function cursorDir(): string {
  return process.env.CURSOR_HOME_DIR ?? join(homedir(), '.cursor');
}

function cursorMcpJsonPath(): string {
  return join(cursorDir(), 'mcp.json');
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

function isCursorServerEntry(value: unknown): value is CursorServerEntry {
  if (!isJsonObject(value)) return false;
  if (typeof value.command !== 'string') return false;
  if (!Array.isArray(value.args)) return false;
  return value.args.every((arg) => typeof arg === 'string');
}

function entriesEqual(a: CursorServerEntry, b: CursorServerEntry): boolean {
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
 * Read `~/.cursor/mcp.json` as a JSON object.
 *
 * Missing file or unparseable/non-object content both default to `{}` —
 * same discipline as the rest of the registry's file-backed projectors:
 * there is nothing sensible to "surgically preserve" from a file that either
 * doesn't exist or doesn't parse, so we treat it as a blank document and let
 * `project()` populate only the `fortmesa` key going forward.
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
 * Detect whether Cursor is plausibly installed on this machine: either its
 * config file already exists, or its config directory does (created by
 * Cursor itself on first run, even before any MCP servers are configured).
 */
export async function detect(): Promise<boolean> {
  const [mcpJsonExists, dirExists] = await Promise.all([pathExists(cursorMcpJsonPath()), pathExists(cursorDir())]);
  return mcpJsonExists || dirExists;
}

/**
 * Surgical merge of `~/.cursor/mcp.json`: set or delete ONLY the
 * `mcpServers.fortmesa` key. Every other top-level key and every other
 * server entry under `mcpServers` is preserved untouched.
 *
 * `enabled: false` means actively remove our entry (opt-out), not merely
 * skip writing — this is how a user flipping `fortmesa.ideSync.cursor` off
 * cleans up a previously-projected entry.
 */
export async function project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = cursorMcpJsonPath();

  try {
    const root = await readMcpJson(path);
    const mcpServers = isJsonObject(root.mcpServers) ? root.mcpServers : {};
    const existingRaw = mcpServers.fortmesa;

    if (enabled) {
      const desired: CursorServerEntry = { command: spec.command, args: [...spec.args] };
      const existingEntry = isCursorServerEntry(existingRaw) ? existingRaw : undefined;

      if (existingEntry !== undefined && entriesEqual(existingEntry, desired)) {
        return {
          target: TARGET,
          action: 'unchanged',
          detail: `"fortmesa" entry already up to date in ${path}`,
          restartNote: RESTART_NOTE,
        };
      }

      const action = existingRaw === undefined ? 'added' : 'updated';
      const nextRoot: Record<string, unknown> = {
        ...root,
        mcpServers: { ...mcpServers, fortmesa: desired },
      };
      await writeMcpJson(path, nextRoot);

      return {
        target: TARGET,
        action,
        detail: `${action === 'added' ? 'Added' : 'Updated'} "fortmesa" entry in ${path}`,
        restartNote: RESTART_NOTE,
      };
    }

    // enabled === false: remove our entry, touching nothing else.
    if (existingRaw === undefined) {
      const fileExists = await pathExists(path);
      return {
        target: TARGET,
        action: fileExists ? 'unchanged' : 'skipped',
        detail: fileExists
          ? `no "fortmesa" entry present in ${path}; nothing to remove`
          : `Cursor not detected on this machine (no ${path}); nothing to remove`,
        restartNote: RESTART_NOTE,
      };
    }

    const remainingServers = Object.fromEntries(Object.entries(mcpServers).filter(([key]) => key !== 'fortmesa'));
    const nextRoot: Record<string, unknown> = { ...root, mcpServers: remainingServers };
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
      detail: errorMessage(error),
      restartNote: RESTART_NOTE,
    };
  }
}
