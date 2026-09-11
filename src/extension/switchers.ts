import * as vscode from 'vscode';
import { loadConfig, saveConfig, type Config } from '../registry/config.js';
import { errorMessage, type Logger } from './logger.js';
import { openScopeSelectionPanel } from './scope-select-panel.js';

/**
 * Real handlers for the Saferoom scope switchers: `fortmesa.selectScope`
 * (Scope selector row click) and `fortmesa.switchScopeExpert` (opens the
 * primary-pane Accessible scopes panel).
 *
 * The 2026-09-03 UX round deleted two command-palette quickpicks that used
 * to live here — `fortmesa.switchEnvironment` (superseded by the Settings
 * panel's Data region control) and `fortmesa.switchScope` (superseded by the
 * Scope selector view's own rows, which ARE the selection). Neither had a
 * surface left that could only be reached through the palette.
 *
 * `fortmesa.unlockScope` ("Unlock (All Scopes)") went the same way on
 * 2026-09-08 (PO: *"unlock all primary side bar action may be removed (we
 * have a select all option inside the multi-select screen)"*). Note what
 * that trades away, because it is not a pure equivalence: `mode: 'unlocked'`
 * meant "every scope this account is entitled to, INCLUDING ones granted
 * later", while Select all is a snapshot of the scopes that existed when the
 * user pressed it. A scope granted afterwards is inaccessible until the user
 * selects it. `mode: 'unlocked'` remains a valid, fully-rendered config
 * state (a hand-edited config.json, the CLI, or an install predating this
 * change) — `scopeRowPresentation` still has its branch and the status bar
 * still reads "all scopes"; there is simply no longer a button that sets it.
 *
 * Every handler here only ever mutates `~/.fmcode/config.json` via
 * `loadConfig`/`saveConfig` — it never talks to a running proxy directly.
 * Every running proxy instance picks the change up on its own via its
 * `watchConfig()` hot-reload (Phase P0, `cli.ts`/`proxy.ts`), per
 * VSIX-PLAN.md §4.3 / D-V10.
 */

/** `fortmesa.selectScope` — Scopes panel row click (UX-ROUND-2-PLAN.md W5, D-U3): switch directly to the given single scope, no quickpick (the row itself IS the selection). `scopeName` comes from the tree item's own command arguments — see `tree-view.ts`'s `fetchScopeRows`. */
async function handleSelectScope(scopeName: string, log: Logger): Promise<void> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    void vscode.window.showErrorMessage(`FortMesa: failed to load config.json (${errorMessage(error)}).`);
    return;
  }

  const nextConfig: Config = { ...config, scopeLock: { mode: 'single', scopes: [scopeName] } };
  await saveConfig(nextConfig);
  log.info(`fortmesa.selectScope: scope lock set to single: ${scopeName}`);
  void vscode.window.showInformationMessage(`FortMesa: only "${scopeName}" is accessible.`);
}

/** Register the scope switcher handlers, disposed via `context.subscriptions`. `clientVersion` is this extension's own version (see `extension.ts`'s `resolveClientVersion`), used only by the Accessible scopes panel's live gateway scope list. */
export function registerSwitcherCommands(context: vscode.ExtensionContext, log: Logger, clientVersion: string): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.switchScopeExpert', () => {
      openScopeSelectionPanel(context, clientVersion, log);
    }),
    vscode.commands.registerCommand('fortmesa.selectScope', (scopeName: string) => {
      void handleSelectScope(scopeName, log).catch((error: unknown) => {
        log.error(`fortmesa.selectScope failed unexpectedly: ${errorMessage(error)}`);
      });
    }),
  );
}
