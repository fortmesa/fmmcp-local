import { join } from 'node:path';
import type { Config } from './config.js';
import * as claude from './projectors/claude.js';
import * as cursor from './projectors/cursor.js';
import * as codex from './projectors/codex.js';
import * as antigravity from './projectors/antigravity.js';
import * as copilot from './projectors/copilot.js';
import type { FortmesaServerSpec, ProjectorResult } from '../shared/types.js';

export type { FortmesaServerSpec, ProjectorResult };

/**
 * IDE projection / sync engine (VSIX-PLAN.md §3.3 "Sync engine
 * responsibilities").
 *
 * Drives the four FILE-BASED projectors (Claude Code, Cursor, Codex,
 * Antigravity) uniformly. VS Code is deliberately NOT one of these targets —
 * it is registered live via the `vscode.lm` MCP API from inside the
 * extension host (Phase P2), not through a config-file projector, so it has
 * no place in a `vscode`-import-free module like this one.
 *
 * Every projector module (`./projectors/*.ts`) independently implements the
 * exact same `detect()`/`project()` contract via structural typing (no
 * shared runtime base — see each module's own doc comment); this file is the
 * one place that type is treated as common, borrowed here from `./claude.js`
 * and re-exported so callers (the CLI, and later the extension) have a
 * single import path for it.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (mirrors src/registry/config.ts and src/registry/scope-resolve.ts).
 */

/** The subset of `Config['ideSync']` keys that correspond to a file-based projector (i.e. everything except `vscode`). */
type FileSyncTarget = 'claude' | 'cursor' | 'codex' | 'antigravity' | 'copilot';

/** The `detect`/`project` pair every file-based projector module exports. */
interface FileProjectorModule {
  detect(): Promise<boolean>;
  project(spec: FortmesaServerSpec, enabled: boolean): Promise<ProjectorResult>;
}

interface FileProjectorEntry {
  readonly target: FileSyncTarget;
  readonly module: FileProjectorModule;
}

/** All file-based targets, driven uniformly. Order here is preserved in the returned/reported results. */
const FILE_PROJECTORS: readonly FileProjectorEntry[] = [
  { target: 'claude', module: claude },
  { target: 'cursor', module: cursor },
  { target: 'codex', module: codex },
  { target: 'antigravity', module: antigravity },
  { target: 'copilot', module: copilot },
];

/** Result shape for the "target was never installed on this machine" case, built here rather than by any one projector module. */
function notDetectedResult(target: FileSyncTarget): ProjectorResult {
  return {
    target,
    action: 'skipped',
    detail: `skipped: ${target} not detected on this machine (no CLI/config found) — nothing was written`,
    restartNote: 'not applicable — nothing was changed',
  };
}

/** Result shape for an unexpected throw from a projector's `detect`/`project` that its own internal error handling didn't already catch. */
function unexpectedErrorResult(target: FileSyncTarget, error: unknown): ProjectorResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    target,
    action: 'error',
    detail: `unexpected error while syncing ${target}: ${message}`,
    restartNote: 'not applicable — an unexpected error occurred, see detail',
  };
}

/**
 * Run one target's opt-out/detect/project decision tree (VSIX-PLAN.md §3.3):
 *
 * - `ideSync.<target>` is `false` (opt-out): call `project(spec, false)`
 *   unconditionally — this actively retracts a previous sync, it never just
 *   silently skips (a user turning sync off for a target expects any earlier
 *   `fortmesa` entry to disappear from that target's config).
 * - `ideSync.<target>` is `true`: call `detect()` first, and only call
 *   `project(spec, true)` if the target is actually detected on this
 *   machine — never write into a config file for a target that clearly
 *   isn't installed.
 *
 * Never rejects: every branch is wrapped so a single target's failure can't
 * take down `Promise.all` for the others (the individual projector modules
 * already catch internally, but this is a second, defensive layer in case a
 * `detect()`/`project()` implementation ever throws unexpectedly).
 */
async function runOneTarget(
  entry: FileProjectorEntry,
  spec: FortmesaServerSpec,
  config: Config,
): Promise<ProjectorResult> {
  const enabled = config.ideSync[entry.target];

  try {
    if (!enabled) {
      return await entry.module.project(spec, false);
    }

    const detected = await entry.module.detect();
    if (!detected) {
      return notDetectedResult(entry.target);
    }

    return await entry.module.project(spec, true);
  } catch (error) {
    return unexpectedErrorResult(entry.target, error);
  }
}

/** The tail of a summary line: the module's own pick-up guidance for a real outcome, or the `detail` when there's nothing to pick up (skipped/error). */
function noteOrDetail(result: ProjectorResult): string {
  if (result.action === 'skipped' || result.action === 'error') return result.detail;
  return result.restartNote;
}

/**
 * Sync the canonical `fortmesa` MCP server entry into all four file-based IDE
 * targets, honoring each one's `config.ideSync.<target>` opt-out.
 *
 * `repoRoot` is supplied by the caller rather than guessed here (the CLI
 * passes its own package root; a future extension caller passes its install
 * directory or a configured path) — this module has no opinion on where it
 * is running from.
 *
 * The four targets touch entirely disjoint files, so they run concurrently
 * via `Promise.all`; each one's outcome (including a caught error) is always
 * represented as a `ProjectorResult`, so this function itself never rejects
 * because of a single target's failure.
 */
export async function syncAllTargets(
  config: Config,
  repoRoot: string,
  log: (msg: string) => void,
): Promise<ProjectorResult[]> {
  const spec: FortmesaServerSpec = { command: join(repoRoot, 'launch-mcp.sh'), args: [] };

  const results = await Promise.all(FILE_PROJECTORS.map((entry) => runOneTarget(entry, spec, config)));

  for (const result of results) {
    log(`${result.target}: ${result.action} — ${noteOrDetail(result)}`);
  }

  return results;
}

/**
 * Render a human-readable, multi-line post-sync report — one line per
 * target — reused by both the CLI's `sync` subcommand output and, later, the
 * extension's Saferoom UI.
 */
export function summarizeSyncReport(results: ProjectorResult[]): string {
  return results.map((result) => `${result.target}: ${result.action} (${noteOrDetail(result)})`).join('\n');
}
