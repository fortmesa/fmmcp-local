import * as vscode from 'vscode';
import { loadConfig } from '../registry/config.js';
import { appLaunchUrl, ENVIRONMENTS } from '../registry/environments.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * `fortmesa.openApp` ("FortMesa App", UX-ROUND-2-PLAN.md W7/U10): opens the
 * active environment's FortMesa app URL — host + `/a/` — in the system
 * browser.
 *
 * D-U7/D-U9 (simplified, 2026-07-06): all four app URLs are hardcoded in
 * `src/registry/environments.ts` — no runtime detection, no BrandAsset/
 * scope-branding lookup. `sandbox`'s app URL is `*.mesa.red`, which is
 * Cloudflare-WARP-gated for browsers (see `tree-view.ts`'s Saferoom
 * launcher row, which surfaces that as a tooltip when sandbox is active).
 */
async function handleOpenApp(log: Logger): Promise<void> {
  let env: string;
  try {
    env = (await loadConfig()).activeEnv;
  } catch (error) {
    void vscode.window.showErrorMessage(`FortMesa: failed to load config.json (${errorMessage(error)}).`);
    return;
  }

  if (ENVIRONMENTS[env]?.app === undefined) {
    void vscode.window.showErrorMessage(`FortMesa: no app URL known for environment "${env}".`);
    return;
  }

  // `/a/` is the app's own path under the environment's host — see
  // `appLaunchUrl` (PO, 2026-09-05). Derived per environment, never
  // hardcoded to production.
  const appUrl = appLaunchUrl(env);

  await vscode.env.openExternal(vscode.Uri.parse(appUrl));
  log.info(`fortmesa.openApp: opened ${appUrl} (env: ${env})`);
}

/** Register the real `fortmesa.openApp` handler, disposed via `context.subscriptions`. */
export function registerSaferoomLauncherCommands(context: vscode.ExtensionContext, log: Logger): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.openApp', () => {
      void handleOpenApp(log).catch((error: unknown) => {
        log.error(`fortmesa.openApp failed unexpectedly: ${errorMessage(error)}`);
      });
    }),
  );
}
