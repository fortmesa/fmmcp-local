import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { parse, stringify, TomlDate, type TomlTableWithoutBigInt, type TomlValueWithoutBigInt } from 'smol-toml';
import type { FortmesaServerSpec, ProjectorResult } from '../../shared/types.js';

/**
 * OpenAI Codex CLI/IDE projector (VSIX-PLAN.md §3.3 row 4; curriculum
 * 04-ide-integration-matrix.md §4).
 *
 * Two mutation paths, official CLI preferred:
 *
 * 1. **`codex` on PATH**: shell out to `codex mcp add fortmesa -- <command>
 *    <args...>` (enable) / `codex mcp remove fortmesa` (disable). This is the
 *    plan-of-record path (curriculum 04 §4) specifically because it avoids
 *    the TOML round-trip's formatting loss (see point 2). NOTE: the `codex`
 *    binary is NOT installed on this dev pod (verified via `which codex` —
 *    absent, and `~/.codex/config.toml` does not exist either), so this
 *    exact subcommand syntax could not be live-verified against `codex mcp
 *    --help` here. It is taken verbatim from VSIX-PLAN.md/curriculum as the
 *    documented, current Codex CLI surface. Re-verify with `codex mcp --help`
 *    the first time this runs somewhere `codex` is actually installed, and
 *    fix this module (not just the comment) if the real syntax differs.
 * 2. **File fallback** (`codex` not on PATH): TOML-aware surgical merge of
 *    `~/.codex/config.toml` via `smol-toml`. Only `mcp_servers.fortmesa` is
 *    ever read or written — every other table in the file round-trips
 *    untouched *by value*. Important limitation: `smol-toml`'s `stringify()`
 *    re-serializes the whole document from its parsed data model, so it does
 *    **not** preserve comments or the original formatting/ordering of
 *    untouched tables — the round-trip is value-preserving, not
 *    byte-preserving. This is a known, accepted limitation (VSIX-PLAN.md §3.3
 *    calls out preferring the official CLI specifically to avoid it); it is
 *    only exercised at all when the CLI is unavailable.
 *
 * Opt-out (`enabled=false`) deletes the whole `mcp_servers.fortmesa` table
 * rather than writing `enabled: false` into it — we have not verified that
 * Codex actually honors a per-server `enabled` flag, so "entry absent" is the
 * only opt-out semantics we're willing to assert.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (mirrors src/registry/config.ts and src/registry/scope-resolve.ts,
 * including their `*_DIR` env-var override convention for tests, here
 * `CODEX_HOME_DIR`).
 */

const TARGET = 'codex';
const RESTART_NOTE = 'restart your next Codex CLI/IDE invocation to pick up this change';

/** Resolve the Codex home directory. `CODEX_HOME_DIR` overrides `~/.codex` for tests. */
function codexDir(): string {
  return process.env.CODEX_HOME_DIR ?? join(homedir(), '.codex');
}

/** Absolute path to `config.toml` under the (possibly overridden) Codex home dir. */
function codexConfigPath(): string {
  return join(codexDir(), 'config.toml');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Extract a useful message from a (promisified) `execFile` rejection: prefer
 * the child's stderr (what a human would see running the command themselves)
 * and fall back to the Error's own message. `execFile`'s rejection augments
 * the Error with `stdout`/`stderr` at runtime (see Node's `ExecFileException`)
 * but that shape isn't carried through `util.promisify`'s typings, so this
 * narrows with an explicit runtime check rather than typing the whole catch
 * variable (cast-with-comment precedent: curriculum 08-pitfalls-log.md #8).
 */
function execFileErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const withStderr = error as Error & { stderr?: unknown };
  const stderr = typeof withStderr.stderr === 'string' ? withStderr.stderr.trim() : '';
  return stderr !== '' ? stderr : error.message;
}

function isTomlTable(value: TomlValueWithoutBigInt | undefined): value is TomlTableWithoutBigInt {
  // No `!== null` check: smol-toml's `TomlValueWithoutBigInt` has no `null`
  // member (TOML itself has no null type), so TypeScript already narrows
  // `typeof value === 'object'` to exclude it — an explicit check is
  // unreachable and trips `@typescript-eslint/no-unnecessary-condition`.
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDate);
}

/** Does the existing `mcp_servers.fortmesa` value already match what we'd write for `enabled=true`? */
function fortmesaEntryMatches(existing: TomlValueWithoutBigInt | undefined, spec: FortmesaServerSpec): boolean {
  if (!isTomlTable(existing)) return false;

  const { command, args, enabled } = existing;
  if (typeof command !== 'string' || command !== spec.command) return false;
  if (enabled !== true) return false;
  if (!Array.isArray(args) || args.length !== spec.args.length) return false;

  return args.every((value, index) => typeof value === 'string' && value === spec.args[index]);
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
 * Is a `codex` executable present on `PATH`? Checked by direct filesystem
 * probing (`X_OK` access on `<dir>/codex` for each `PATH` entry) rather than
 * shelling out to `which`/`command -v`, so this has no dependency on either
 * being present in a minimal container image.
 */
async function isCodexCliOnPath(): Promise<boolean> {
  const pathEnv = process.env.PATH;
  if (pathEnv === undefined || pathEnv === '') return false;

  const dirs = pathEnv.split(delimiter).filter((dir) => dir !== '');
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await access(join(dir, 'codex'), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );

  return results.includes(true);
}

interface TomlReadResult {
  readonly doc: TomlTableWithoutBigInt;
  readonly fileExisted: boolean;
}

/**
 * Read+parse `config.toml`. Missing file -> empty document (`fileExisted:
 * false`). Present-but-unparseable file (e.g. hand-corrupted TOML) -> also
 * treated as an empty document per this module's documented contract, but
 * `fileExisted: true` so callers can still report an accurate "file present"
 * detail rather than implying it was never there. Any other read error
 * (e.g. EACCES) propagates to the caller.
 */
async function readTomlDocument(path: string): Promise<TomlReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return { doc: {}, fileExisted: false };
    }
    throw error;
  }

  try {
    // The explicit `{}` (rather than a bare `parse(raw)` call) is required to
    // pin TypeScript to smol-toml's `TomlTableWithoutBigInt`-returning parse
    // overload — with no second argument at all, overload resolution instead
    // matches the *first* declared overload (which types integers as
    // possible `bigint`s), since that overload's options parameter is also
    // optional.
    return { doc: parse(raw, {}), fileExisted: true };
  } catch {
    return { doc: {}, fileExisted: true };
  }
}

/**
 * Atomically write the TOML document (tmp file + rename, matching
 * src/registry/config.ts's saveConfig) so a concurrent reader never observes
 * a half-written file.
 *
 * NOTE: `stringify()` re-serializes the entire document from its in-memory
 * data model. It is value-preserving for every table we didn't touch, but it
 * is NOT byte-preserving — comments and original formatting/key ordering
 * elsewhere in the file are lost. See the module doc comment.
 */
async function writeTomlDocument(path: string, doc: TomlTableWithoutBigInt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, stringify(doc), 'utf-8');
  await rename(tmpPath, path);
}

/** Best-effort peek at the current `mcp_servers.fortmesa` value, used only to label the CLI path's action. Never throws. */
async function peekExistingEntry(): Promise<TomlValueWithoutBigInt | undefined> {
  try {
    const { doc } = await readTomlDocument(codexConfigPath());
    const mcpServers = doc.mcp_servers;
    return isTomlTable(mcpServers) ? mcpServers.fortmesa : undefined;
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Project via the official `codex` CLI. The CLI is the source of truth for
 * `~/.codex/config.toml`'s exact on-disk representation (including comments),
 * so this module only ever *reads* that file here (via `peekExistingEntry`)
 * to decide whether to report `'added'`/`'updated'`/`'unchanged'` — it never
 * writes the file directly on this path.
 */
async function projectViaCli(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const existingEntry = await peekExistingEntry();

  if (!enabled) {
    if (existingEntry === undefined) {
      return {
        target: TARGET,
        action: 'unchanged',
        detail: 'codex CLI detected; no "mcp_servers.fortmesa" entry present, nothing to remove',
        restartNote: RESTART_NOTE,
      };
    }

    try {
      await execFileAsync('codex', ['mcp', 'remove', 'fortmesa']);
    } catch (error) {
      return {
        target: TARGET,
        action: 'error',
        detail: `"codex mcp remove fortmesa" failed: ${execFileErrorDetail(error)}`,
        restartNote: RESTART_NOTE,
      };
    }

    return {
      target: TARGET,
      action: 'updated',
      detail: 'removed the "fortmesa" server via "codex mcp remove fortmesa"',
      restartNote: RESTART_NOTE,
    };
  }

  if (fortmesaEntryMatches(existingEntry, spec)) {
    return {
      target: TARGET,
      action: 'unchanged',
      detail: 'codex CLI detected; "mcp_servers.fortmesa" already matches the desired spec',
      restartNote: RESTART_NOTE,
    };
  }

  const wasPresent = existingEntry !== undefined;

  try {
    await execFileAsync('codex', ['mcp', 'add', 'fortmesa', '--', spec.command, ...spec.args]);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `"codex mcp add fortmesa" failed: ${execFileErrorDetail(error)}`,
      restartNote: RESTART_NOTE,
    };
  }

  return {
    target: TARGET,
    action: wasPresent ? 'updated' : 'added',
    detail: `${wasPresent ? 'updated' : 'added'} the "fortmesa" server via "codex mcp add"`,
    restartNote: RESTART_NOTE,
  };
}

/**
 * Project via a direct TOML-aware merge of `~/.codex/config.toml` (no `codex`
 * CLI on `PATH`). Surgical: only `mcp_servers.fortmesa` is ever set or
 * deleted; every other table (including sibling entries under `mcp_servers`)
 * is preserved by value.
 */
async function projectViaFileFallback(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  const path = codexConfigPath();

  try {
    const { doc, fileExisted } = await readTomlDocument(path);
    const existingMcpServers = doc.mcp_servers;
    const mcpServers: TomlTableWithoutBigInt = isTomlTable(existingMcpServers) ? { ...existingMcpServers } : {};
    const existingEntry = mcpServers.fortmesa;

    if (!enabled) {
      if (existingEntry === undefined) {
        return {
          target: TARGET,
          action: fileExisted ? 'unchanged' : 'skipped',
          detail: fileExisted
            ? `no "mcp_servers.fortmesa" table present in ${path}; nothing to remove`
            : `${path} does not exist and the codex CLI is not on PATH; nothing to remove`,
          restartNote: RESTART_NOTE,
        };
      }

      delete mcpServers.fortmesa;
      doc.mcp_servers = mcpServers;
      await writeTomlDocument(path, doc);

      return {
        target: TARGET,
        action: 'updated',
        detail: `removed "mcp_servers.fortmesa" from ${path}`,
        restartNote: RESTART_NOTE,
      };
    }

    if (fortmesaEntryMatches(existingEntry, spec)) {
      return {
        target: TARGET,
        action: 'unchanged',
        detail: `"mcp_servers.fortmesa" in ${path} already matches the desired spec`,
        restartNote: RESTART_NOTE,
      };
    }

    const wasPresent = existingEntry !== undefined;
    mcpServers.fortmesa = { command: spec.command, args: [...spec.args], enabled: true };
    doc.mcp_servers = mcpServers;
    await writeTomlDocument(path, doc);

    return {
      target: TARGET,
      action: wasPresent ? 'updated' : 'added',
      detail: `${wasPresent ? 'updated' : 'added'} "mcp_servers.fortmesa" in ${path}`,
      restartNote: RESTART_NOTE,
    };
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `failed to update ${path}: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }
}

/**
 * Detect whether Codex is plausibly installed on this machine: either the
 * `codex` CLI is on `PATH`, or `~/.codex/config.toml` already exists (curriculum
 * 04 §4 — Codex has no separate "installed but never configured" marker we
 * can probe for besides these two).
 */
export async function detect(): Promise<boolean> {
  const [cliOnPath, configExists] = await Promise.all([isCodexCliOnPath(), pathExists(codexConfigPath())]);
  return cliOnPath || configExists;
}

/**
 * Project (or opt-out) the canonical `fortmesa` MCP server entry for Codex.
 * Prefers the official `codex mcp add`/`codex mcp remove` CLI when `codex` is
 * on `PATH`; otherwise falls back to a surgical TOML merge of
 * `~/.codex/config.toml`. `enabled=false` actively removes our entry rather
 * than merely skipping — see the module doc comment for why deletion (not an
 * in-file `enabled: false`) is how this target's opt-out works.
 */
export async function project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult> {
  try {
    if (await isCodexCliOnPath()) {
      return await projectViaCli(spec, enabled);
    }
    return await projectViaFileFallback(spec, enabled);
  } catch (error) {
    return {
      target: TARGET,
      action: 'error',
      detail: `unexpected error while projecting to Codex: ${errorMessage(error)}`,
      restartNote: RESTART_NOTE,
    };
  }
}
