import * as vscode from 'vscode';
import { loadConfig } from '../registry/config.js';
import { environmentSwitchChoices } from '../registry/custom-servers.js';
import { environmentLabel, isSelectableEnv } from '../registry/environments.js';
import { notifyIdentityChanged } from '../registry/identity-events.js';
import { signOutOfEnvironment } from './auth-commands.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * Sign out and Switch environment as commands (FMDEV-879).
 *
 * PO live test, 0.9.150: an expired token-only session had no way out. The
 * expired state hid the Sign out button, and nothing offered another
 * environment. These two commands are reachable from the command palette and
 * from the expired box in the Signed-in user view, whatever the session state.
 */

/** Clear the stored credential for the active environment. Returns whether anything was stored. */
export async function signOutOfActiveEnvironment(log: Logger): Promise<boolean> {
  const env = (await loadConfig()).activeEnv;
  const cleared = await signOutOfEnvironment(env);
  log.info(cleared ? `Signed out of "${env}"` : `Sign out requested for "${env}" but nothing was stored`);
  // credentials.json changed, which the config watcher does not see: fan out
  // so the tree, status bar and open panels drop the old identity.
  notifyIdentityChanged({ kind: 'signed-out', env });
  return cleared;
}

/**
 * Take the user to the Data region control so they can pick another
 * environment. Reads config.json only, never a credential, so it works signed
 * out or with an expired session. The pick itself lives in Settings rather
 * than a quick pick: the PO ruled every question onto a page, not a palette
 * prompt (sign-in-page-wiring.test.mjs).
 */
export async function switchEnvironmentInteractively(): Promise<void> {
  const config = await loadConfig();
  const choices = environmentSwitchChoices(config.environments, config.activeEnv, isSelectableEnv);
  if (choices.length === 0) {
    void vscode.window.showInformationMessage(
      `FortMesa: ${environmentLabel(config.activeEnv)} is the only environment available. Add a server in Settings › Data region.`,
    );
  }
  await vscode.commands.executeCommand('fortmesa.openSaferoomSettings', { section: 'dataRegion' });
}

export function registerSessionCommands(context: vscode.ExtensionContext, log: Logger): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.signOut', async () => {
      try {
        const cleared = await signOutOfActiveEnvironment(log);
        if (!cleared) void vscode.window.showInformationMessage('FortMesa: nothing was stored for this environment.');
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(`FortMesa: sign out failed (${errorMessage(error)}).`);
      }
    }),
    vscode.commands.registerCommand('fortmesa.switchEnvironment', async () => {
      try {
        await switchEnvironmentInteractively();
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(`FortMesa: could not switch environment (${errorMessage(error)}).`);
      }
    }),
  );
}
