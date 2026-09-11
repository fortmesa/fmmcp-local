import * as vscode from 'vscode';
import { loadConfig, saveConfig, type Config } from '../registry/config.js';
import { summarizeSyncReport, syncAllTargets } from '../registry/sync.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * Real handlers for the Saferoom IDE-sync commands (VSIX-PLAN.md §3.3/§3.5
 * D-V5, as amended by REVISION-PLAN.md A1; R3/F4).
 *
 * The 2026-09-03 UX round deleted `fortmesa.toggleIdeSync` — a
 * command-palette quickpick that flipped exactly one of the five flags the
 * Settings panel's Agents section already renders as checkboxes, with live
 * detection state the quickpick never showed.
 *
 * Both handlers call straight into `src/registry/sync.ts`'s
 * `syncAllTargets`/`summarizeSyncReport` — the same engine the CLI's `sync`
 * subcommand (`cli.ts`) drives — so the VSIX and the CLI always report
 * identical outcomes for the same `config.json`. Nothing here duplicates
 * `sync.ts`'s detect/project decision tree.
 */

/** All five `config.json` `ideSync` targets, in the fixed order they're always shown (matches `config.ts`'s `ideSyncSchema` field order). */
export const IDE_SYNC_TARGETS = ['claude', 'vscode', 'cursor', 'codex', 'antigravity', 'copilot'] as const;

export type IdeSyncTarget = (typeof IDE_SYNC_TARGETS)[number];

/**
 * Run one sync pass and report the result at the right altitude:
 *
 * - The FULL, multi-line report always goes to the logger/OutputChannel — the
 *   detail is available in the UI without ever interrupting the user.
 * - Only genuine ERRORS surface as a (concise) notification; skipped /
 *   unchanged / added / updated are info-level and stay in the output channel.
 * - A "sync complete" confirmation toast fires ONLY when the user explicitly
 *   asked for a sync (`interactive`) — never for the background activation
 *   pass, which runs on every launch and must be silent on success.
 *
 * Shared by `fortmesa.syncNow` and the Agents checkboxes (interactive) and the
 * on-activation / ideSync-flag-change pass in `extension.ts` (silent).
 */
export async function runSyncPass(repoRoot: string, log: Logger, opts: { interactive?: boolean } = {}): Promise<void> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    void vscode.window.showErrorMessage(`FortMesa: failed to load config.json (${errorMessage(error)}).`);
    return;
  }

  const results = await syncAllTargets(config, repoRoot, (msg) => {
    log.info(`sync: ${msg}`);
  });

  log.info(`sync report:\n${summarizeSyncReport(results)}`);

  const errors = results.filter((result) => result.action === 'error');
  if (errors.length > 0) {
    const targets = errors.map((result) => result.target).join(', ');
    void vscode.window.showErrorMessage(
      `FortMesa: IDE sync could not update ${targets}. See the FortMesa output channel for details.`,
    );
    return;
  }

  if (opts.interactive === true) {
    void vscode.window.showInformationMessage('FortMesa: IDE sync complete.');
  }
}

/**
 * Set a single `ideSync.<target>` flag, save, then run an immediate sync
 * pass so the change takes effect right away — the shared core of
 * the Saferoom Settings webview's Agents section (checkboxes) — kept as a
 * separate exported function so the panel never inlines the
 * load/mutate/save/sync sequence.
 */
export async function setIdeSyncTarget(
  target: IdeSyncTarget,
  enabled: boolean,
  repoRoot: string,
  log: Logger,
): Promise<void> {
  const config = await loadConfig();
  const nextConfig: Config = { ...config, ideSync: { ...config.ideSync, [target]: enabled } };
  await saveConfig(nextConfig);
  log.info(`ideSync: ${target} sync ${enabled ? 'enabled' : 'disabled'}`);
  await runSyncPass(repoRoot, log, { interactive: true });
}

/** Register the real `fortmesa.syncNow` handler, disposed via `context.subscriptions`. `repoRoot` is the already-resolved checked-out repo root (`extension.ts`'s `resolveRepoRoot`) — reused as-is, never re-derived here. */
export function registerIdeSyncCommands(context: vscode.ExtensionContext, repoRoot: string, log: Logger): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.syncNow', () => {
      void runSyncPass(repoRoot, log, { interactive: true }).catch((error: unknown) => {
        log.error(`fortmesa.syncNow failed unexpectedly: ${errorMessage(error)}`);
      });
    }),
  );
}
