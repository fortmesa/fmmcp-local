import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { FortmesaServerSpec, ProjectorResult } from '../../shared/types.js';

/**
 * Claude Code IDE projector (VSIX-PLAN.md §3.3 row 1; curriculum
 * 04-ide-integration-matrix.md §1).
 *
 * Two mutation paths, official CLI preferred:
 *
 * 1. **`claude` on PATH**: shell out to `claude mcp add-json fortmesa '<json>'
 *    --scope user` (enable) / `claude mcp remove fortmesa --scope user`
 *    (disable) — the documented, plan-of-record path (curriculum 04 §1),
 *    specifically to avoid ever touching `~/.claude.json` by hand (that file
 *    also holds sessions/approvals/onboarding state; whole-file rewrites are
 *    catastrophic). This exact subcommand syntax (`mcp add-json <name> <json>
 *    --scope user`, `mcp remove <name> --scope user`) was live-verified in
 *    this pod against the actually-installed `claude` CLI (v2.1.197, `claude
 *    mcp --help` / `claude mcp add-json --help` / `claude mcp remove --help`)
 *    — it matches the curriculum exactly, no discrepancy found. Re-verify the
 *    first time this drifts.
 * 2. **File fallback** (`claude` not on PATH): surgical merge of the single
 *    `mcpServers.fortmesa` key in `~/.claude.json`. Every other top-level key
 *    (sessions, approvals, onboarding flags, `oauthAccount`, etc.) and every
 *    sibling `mcpServers` entry round-trips *by value* — this module only
 *    ever reads and reassigns `mcpServers.fortmesa`. Missing or unparseable
 *    files are treated as `{}` and a fresh file is created; there is no
 *    comment/whitespace to preserve (Claude's config is plain JSON), so a
 *    full re-serialize (2-space indent) is safe here — value fidelity is what
 *    matters, not byte fidelity.
 *
 * Both paths use `--scope user` (`~/.claude.json`, all projects) per
 * curriculum 04 §1 — never `local` or `project` (`.mcp.json`, VCS-shared,
 * needs interactive approval).
 *
 * `enabled=false` actively removes our entry (opt-out), not merely skip —
 * this is how flipping `fortmesa.ideSync.claude` off cleans up a previously
 * projected entry. Pick-up is next-session only (no live watch for this
 * target), so `restartNote` always tells the user to restart their session.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (mirrors src/registry/config.ts and src/registry/scope-resolve.ts,
 * including their `*_DIR` env-var override convention for tests, here
 * `CLAUDE_HOME_DIR` — mirrors sibling projectors' `CODEX_HOME_DIR`/
 * `GEMINI_HOME_DIR`).
 */

const TARGET = 'claude';
const SERVER_NAME = 'fortmesa';
const RESTART_NOTE = 'restart your Claude Code session to pick up this change';

/** The exact shape written under `mcpServers.fortmesa` (curriculum 04 §1: `${VAR}` expansion supported — we never emit it). */
interface ClaudeServerEntry {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** Resolve the "home" directory `~/.claude.json` lives under. `CLAUDE_HOME_DIR` overrides `homedir()` for tests. */
function claudeHomeDir(): string {
  return process.env.CLAUDE_HOME_DIR ?? homedir();
}

/** Absolute path to `~/.claude.json` under the (possibly overridden) home dir. */
function claudeJsonPath(): string {
  return join(claudeHomeDir(), '.claude.json');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaudeServerEntry(value: unknown): value is ClaudeServerEntry {
  if (!isJsonObject(value)) return false;
  if (value.type !== 'stdio') return false;
  if (typeof value.command !== 'string') return false;
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) return false;
  if (!isJsonObject(value.env)) return false;
  return Object.values(value.env).every((v) => typeof v === 'string');
}

function entriesEqual(a: ClaudeServerEntry, b: ClaudeServerEntry): boolean {
  if (a.command !== b.command) return false;
  if (a.args.length !== b.args.length) return false;
  if (!a.args.every((value, index) => value === b.args[index])) return false;

  const aEnvKeys = Object.keys(a.env).sort();
  const bEnvKeys = Object.keys(b.env).sort();
  if (aEnvKeys.length !== bEnvKeys.length) return false;
  return aEnvKeys.every((key, index) => key === bEnvKeys[index] && a.env[key] === b.env[key]);
}

function buildDesiredEntry(spec: FortmesaServerSpec): ClaudeServerEntry {
  return { type: 'stdio', command: spec.command, args: [...spec.args], env: {} };
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
 * Is a `claude` executable present on `PATH`? Checked by direct filesystem
 * probing (`X_OK` access on `<dir>/claude` for each `PATH` entry) rather than
 * shelling out to `which`, so this has no dependency on `which` being present
 * in a minimal container image (mirrors `./codex.ts`'s `isCodexCliOnPath`) and
 * is deterministically forceable in tests by clearing `PATH`.
 */
async function isClaudeCliOnPath(): Promise<boolean> {
  const pathEnv = process.env.PATH;
  if (pathEnv === undefined || pathEnv === '') return false;

  const dirs = pathEnv.split(delimiter).filter((dir) => dir !== '');
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await access(join(dir, 'claude'), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );

  return results.includes(true);
}

/**
 * Read `~/.claude.json` as a loosely-typed JSON object (NOT schema-validated
 * away to a known shape) — every top-level key besides the one this module
 * manages (`mcpServers.fortmesa`) must round-trip untouched, including keys
 * unknown to this module (sessions, approvals, onboarding flags, etc.). A
 * missing or unparseable file is treated as `{}` per the module doc comment.
 */
async function readClaudeJson(path: string): Promise<Record<string, unknown>> {
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

/** Atomically write the JSON object (tmp file + rename, matching src/registry/config.ts's saveConfig), 2-space indented. */
async function writeClaudeJson(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, path);
}

/** Best-effort peek at the current `mcpServers.fortmesa` value, used only to label the CLI path's action. Never throws. */
async function peekExistingEntry(path: string): Promise<unknown> {
  try {
    const root = await readClaudeJson(path);
    const mcpServers = root.mcpServers;
    return isJsonObject(mcpServers) ? mcpServers[SERVER_NAME] : undefined;
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Extract a useful message from a (promisified) `execFile` rejection: prefer
 * the child's stderr (what a human would see running the command themselves)
 * and fall back to the Error's own message (mirrors `./codex.ts`'s
 * `execFileErrorDetail`).
 */
function execFileErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const withStderr = error as Error & { stderr?: unknown };
  const stderr = typeof withStderr.stderr === 'string' ? withStderr.stderr.trim() : '';
  return stderr !== '' ? stderr : error.message;
}

/**
 * Detect whether Claude Code is plausibly installed on this machine: either
 * the `claude` CLI is on `PATH`, or `~/.claude.json` already exists (curriculum
 * 04 §1 — a user could have configured MCP servers by hand before ever having
 * the CLI on this particular machine's PATH, e.g. a synced dotfile).
 */
export async function detect(): Promise<boolean> {
  const [cliOnPath, jsonExists] = await Promise.all([isClaudeCliOnPath(), pathExists(claudeJsonPath())]);
  return cliOnPath || jsonExists;
}

/**
 * Project via the official `claude` CLI. The CLI is the source of truth for
 * `~/.claude.json`'s exact on-disk representation, so this module only ever
 * *reads* that file here (via `peekExistingEntry`) to decide whether to
 * report `'added'`/`'updated'`/`'unchanged'` — it never writes the file
 * directly on this path (mirrors `./codex.ts`'s `projectViaCli`).
 */
async function projectViaCli(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = claudeJsonPath();
  const existingRaw = await peekExistingEntry(path);

  if (!enabled) {
    if (existingRaw === undefined) {
      return {
        target: TARGET,
        action: 'unchanged',
        detail: `claude CLI detected; no "${SERVER_NAME}" entry present in user-scope mcpServers, nothing to remove`,
        restartNote: RESTART_NOTE,
      };
    }

    try {
      await execFileAsync('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    } catch (error) {
      return {
        target: TARGET,
        action: 'error',
        detail: `"claude mcp remove ${SERVER_NAME} --scope user" failed: ${execFileErrorDetail(error)}`,
        restartNote: RESTART_NOTE,
      };
    }

    return {
      target: TARGET,
      action: 'updated',
      detail: `removed the "${SERVER_NAME}" server via "claude mcp remove ${SERVER_NAME} --scope user"`,
      restartNote: RESTART_NOTE,
    };
  }

  const desired = buildDesiredEntry(spec);
  if (isClaudeServerEntry(existingRaw) && entriesEqual(existingRaw, desired)) {
    return {
      target: TARGET,
      action: 'unchanged',
      detail: `claude CLI detected; "${SERVER_NAME}" already matches the desired spec (user scope)`,
      restartNote: RESTART_NOTE,
    };
  }

  const wasPresent = existingRaw !== undefined;

  // `claude mcp add-json` REFUSES to overwrite an existing server — it exits
  // non-zero with "MCP server <name> already exists in user config". So when an
  // entry is already present but differs from `desired` (e.g. an older proxy
  // path), updating it means remove-then-add, not a bare add-json. (Reaching
  // here at all implies the entry didn't already equal `desired` — the
  // unchanged case returned above — so a present entry always needs replacing.)
  if (wasPresent) {
    try {
      await execFileAsync('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    } catch (error) {
      return {
        target: TARGET,
        action: 'error',
        detail: `"claude mcp remove ${SERVER_NAME} --scope user" (to replace a differing entry) failed: ${execFileErrorDetail(error)}`,
        restartNote: RESTART_NOTE,
      };
    }
  }

  try {
    await execFileAsync('claude', ['mcp', 'add-json', SERVER_NAME, JSON.stringify(desired), '--scope', 'user']);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `"claude mcp add-json ${SERVER_NAME} --scope user" failed: ${execFileErrorDetail(error)}`,
      restartNote: RESTART_NOTE,
    };
  }

  return {
    target: TARGET,
    action: wasPresent ? 'updated' : 'added',
    detail: `${wasPresent ? 'updated' : 'added'} the "${SERVER_NAME}" server via "claude mcp add-json ${SERVER_NAME} --scope user"`,
    restartNote: RESTART_NOTE,
  };
}

/**
 * Project via a direct surgical merge of `~/.claude.json` (no `claude` CLI on
 * `PATH`). Only `mcpServers.fortmesa` is ever set or deleted; every other
 * top-level key (including sibling `mcpServers` entries) is preserved by
 * value (mirrors `./cursor.ts`'s `project`).
 */
async function projectViaFileFallback(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = claudeJsonPath();

  try {
    const root = await readClaudeJson(path);
    const mcpServers = isJsonObject(root.mcpServers) ? root.mcpServers : {};
    const existingRaw = mcpServers[SERVER_NAME];

    if (enabled) {
      const desired = buildDesiredEntry(spec);

      if (isClaudeServerEntry(existingRaw) && entriesEqual(existingRaw, desired)) {
        return {
          target: TARGET,
          action: 'unchanged',
          detail: `"${SERVER_NAME}" entry already up to date in ${path}`,
          restartNote: RESTART_NOTE,
        };
      }

      const action: ProjectorResult['action'] = existingRaw === undefined ? 'added' : 'updated';
      const nextRoot: Record<string, unknown> = {
        ...root,
        mcpServers: { ...mcpServers, [SERVER_NAME]: desired },
      };
      await writeClaudeJson(path, nextRoot);

      return {
        target: TARGET,
        action,
        detail: `${action === 'added' ? 'added' : 'updated'} "${SERVER_NAME}" in mcpServers in ${path}`,
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
          ? `no "${SERVER_NAME}" entry present in ${path}; nothing to remove`
          : `Claude Code not detected on this machine (no CLI on PATH, no ${path}); nothing to remove`,
        restartNote: RESTART_NOTE,
      };
    }

    const remainingServers = Object.fromEntries(Object.entries(mcpServers).filter(([key]) => key !== SERVER_NAME));
    const nextRoot: Record<string, unknown> = { ...root, mcpServers: remainingServers };
    await writeClaudeJson(path, nextRoot);

    return {
      target: TARGET,
      action: 'updated',
      detail: `removed "${SERVER_NAME}" from mcpServers in ${path}`,
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

/**
 * Project (or opt-out) the canonical `fortmesa` MCP server entry for Claude
 * Code. Prefers the official `claude mcp add-json`/`claude mcp remove` CLI
 * (`--scope user`) when `claude` is on `PATH`; otherwise falls back to a
 * surgical merge of `~/.claude.json`. `enabled=false` actively removes our
 * entry rather than merely skipping. Pick-up is always next-session (no live
 * watch for this target).
 */
export async function project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  try {
    if (await isClaudeCliOnPath()) {
      return await projectViaCli(spec, enabled);
    }
    return await projectViaFileFallback(spec, enabled);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `unexpected error while projecting to Claude Code: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }
}
