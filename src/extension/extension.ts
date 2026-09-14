// FortMesa Saferoom — VS Code extension entry point.
//
// This module (and everything under `src/extension/`) is the ONLY place in
// the repo permitted to import `vscode` (see GEMINI.md and
// `.agent/planning/VSIX-PLAN.md` §3.1 — `src/registry/**` stays vscode-free
// so it is importable by both the CLI and the extension).
//
// `activate()` wires together every extension-only module: fork/capability
// detection (`fork-detect.ts`), the live `vscode.lm` MCP provider
// (`mcp-provider.ts`), settings <-> `config.json` reconciliation
// (`settings-sync.ts`), the status bar (`status-bar.ts`), the three
// Saferoom views — the Scope selector and Resources TreeViews
// (`tree-view.ts`, D-U1) plus the Signed-in user WebviewView
// (`identity-view.ts`) — and command registration (`switchers.ts`,
// `login-command.ts`, `ide-sync-commands.ts`, `saferoom-launcher.ts`, plus
// the `fortmesa.refresh` command registered directly below).
//
// Disposal: every resource created here is registered with
// `context.subscriptions` (some indirectly, by the module that created
// them — `registerMcpProvider`/`createStatusBar`/`startSettingsReconciliation`
// all take `context` for exactly this purpose). VS Code disposes the whole
// list automatically on deactivation; `deactivate()` itself only logs a
// final line for observability, since there is nothing left to clean up by
// hand.
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { loadConfig, watchConfig, type Config } from '../registry/config.js';
import { readCredentialsSummary } from '../registry/credentials.js';
import { expiredSessionNotice } from '../registry/session-status.js';
import { detectCapabilities } from './fork-detect.js';
import { disposeIdentityEvents, onIdentityChanged } from '../registry/identity-events.js';
import { registerIdeSyncCommands, runSyncPass } from './ide-sync-commands.js';
import { IdentityViewProvider } from './identity-view.js';
import { registerLoginCommand } from './login-command.js';
import { createLogger, errorMessage } from './logger.js';
import { EventBus } from '../registry/events/event-bus.js';
import { newEventId } from '../registry/events/event-record.js';
import { startEventSink } from '../registry/events/event-sink.js';
import { EventsViewProvider, registerEventViewerCommand } from './events-view.js';
import { registerMcpProvider, type ServerSpec } from './mcp-provider.js';
import { registerSaferoomLauncherCommands } from './saferoom-launcher.js';
import { refreshScopeSelectionIfOpen } from './scope-select-panel.js';
import { refreshSaferoomSettingsIfOpen, registerSaferoomSettingsCommand } from './saferoom-settings.js';
import { startSettingsReconciliation } from './settings-sync.js';
import { createStatusBar, type StatusBarScopeState } from './status-bar.js';
import { registerSwitcherCommands } from './switchers.js';
import { SaferoomLauncherTreeProvider, ScopesTreeProvider } from './tree-view.js';

let outputChannel: vscode.LogOutputChannel | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve this extension's own version, for MCP client self-identification
 * on the short-lived gateway `Client`s `auth-commands.ts` (access-token
 * probe) and `switchers.ts` (live scope list) open — mirrors the CLI's
 * `VERSION` identity on the same gateway.
 *
 * Deliberately NOT `src/shared/version.ts`: that module's `import.meta.url`
 * -> package.json lookup works for the tsc/ESM CLI build, but is unreachable
 * in the esbuild CJS extension bundle — esbuild replaces `import.meta` with
 * `{}` in `--format=cjs` output, so `fileURLToPath(import.meta.url)` throws
 * immediately at module load (confirmed: it crashed `activate()` before the
 * extension ever rendered, the first time this phase tried importing it
 * here). `context.extension.packageJSON` is the VS-Code-native way to read
 * an extension's own manifest at runtime, unaffected by how the host bundle
 * was built. `packageJSON` is `any`-typed by `@types/vscode`, hence the
 * `isRecord`/`typeof` narrowing below rather than a direct `.version` access.
 */
function resolveClientVersion(context: vscode.ExtensionContext): string {
  const packageJson: unknown = context.extension.packageJSON;
  return isRecord(packageJson) && typeof packageJson.version === 'string' ? packageJson.version : '0.0.0-unknown';
}

/**
 * Pure field-by-field comparison of the five `ideSync.*` booleans
 * (REVISION-PLAN.md R3/A1: "sync on activation + when an ideSync flag
 * changes + manual Sync Now" — NOT on every config change, since IDE
 * projections are byte-stable across env/scope switches by design).
 *
 * `previous === undefined` (the very first `applyConfig` call, at
 * activation) always counts as "changed" — exported standalone so it's
 * exercisable by a plain Node unit test without a real
 * `vscode.ExtensionContext`.
 */
export function ideSyncChanged(previous: Config['ideSync'] | undefined, next: Config['ideSync']): boolean {
  if (previous === undefined) return true;
  return (
    previous.claude !== next.claude ||
    previous.vscode !== next.vscode ||
    previous.cursor !== next.cursor ||
    previous.codex !== next.codex ||
    previous.antigravity !== next.antigravity ||
    previous.copilot !== next.copilot
  );
}

/**
 * Resolve the proxy-launch server spec from the extension's OWN install
 * path — never the open workspace folder (UX-ROUND-2-PLAN.md W1 / T020).
 *
 * `launch-mcp.sh` and the esbuild-bundled CLI (`dist-ext/cli.cjs`, built by
 * `yarn build:cli`) are shipped INSIDE the `.vsix` (`.vscodeignore` no
 * longer excludes `launch-mcp.sh`; `package:ext` runs `build:cli`), so
 * `extensionPath` is always a valid launch directory: the checked-out repo
 * itself when running unpacked from source (that IS the extension's install
 * path in dev), and the packaged extension's install directory once shipped
 * — in both cases regardless of what workspace folder (if any) happens to be
 * open. The prior workspace-folder-based resolution broke the moment VS
 * Code's workspace root wasn't this exact repo checkout: in this pod,
 * `workspaceFolders[0]` resolves to `/workspaces` (the multi-repo parent),
 * so the projected command pointed at a nonexistent
 * `/workspaces/launch-mcp.sh` — the extension's own auto-sync silently wrote
 * a broken entry into every synced IDE. Pure and vscode-free (only a string
 * in, an object out) so it's directly unit-testable without a real
 * `vscode.ExtensionContext` — see
 * `test/registry/extension-resolve-server-spec.test.mjs`.
 */
export function resolveServerSpec(extensionPath: string): ServerSpec {
  return { command: join(extensionPath, 'launch-mcp.sh'), args: [] };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('FortMesa Saferoom', { log: true });
  context.subscriptions.push(channel);
  outputChannel = channel;
  const log = createLogger(channel);
  log.info('FortMesa Saferoom activating…');

  const capabilities = detectCapabilities();
  log.info(
    `detected capabilities: hasLmMcpProvider=${String(capabilities.hasLmMcpProvider)}, ` +
      `hasCursorMcpApi=${String(capabilities.hasCursorMcpApi)}, isRemote=${String(capabilities.isRemote)}`,
  );

  const repoRoot = context.extensionPath;
  const serverSpec = resolveServerSpec(repoRoot);
  log.info(`launch-mcp.sh / bundled CLI resolved from the extension install path: ${repoRoot}`);
  // Belt-and-braces: some packaging/install paths don't reliably preserve the
  // executable bit on a shell script shipped inside a .vsix. Re-assert it
  // before the file is ever spawned; a failure here (e.g. a read-only
  // install dir) is logged, not fatal — the spawn itself will surface the
  // real error if the bit truly can't be set.
  try {
    chmodSync(serverSpec.command, 0o755);
  } catch (error) {
    log.warn(`could not ensure launch-mcp.sh is executable: ${errorMessage(error)}`);
  }

  // Tracks the most recently loaded config so the MCP provider's spec
  // callback (called fresh on every VS Code re-fetch) can honor
  // `ideSync.vscode` without threading a second variable through — see
  // `applyConfig` below, which is the only writer. `undefined` until the
  // first `loadConfig()` resolves; `registerMcpProvider` degrades that to
  // "serve no definition" rather than assuming the flag is on, matching the
  // conservative default while activation is still in flight.
  let currentConfig: Config | undefined;
  const mcpProvider = registerMcpProvider(
    context,
    () => (currentConfig?.ideSync.vscode === true ? serverSpec : undefined),
    log,
  );

  const statusBar = createStatusBar(context);

  const clientVersion = resolveClientVersion(context);

  // Three separately-registered views (D-U1) — Scopes, Identity, Saferoom
  // launcher — replacing the old single "Saferoom" view's Auth/Environment/
  // Scope/Agents sections.
  const scopesTreeProvider = new ScopesTreeProvider(clientVersion);
  context.subscriptions.push(scopesTreeProvider);
  context.subscriptions.push(vscode.window.createTreeView('fortmesa.scopes', { treeDataProvider: scopesTreeProvider }));

  // ── Event viewer (MFDV-246) ────────────────────────────────
  // The buffer is constructed HERE, per activation, and nowhere else. That is
  // what makes "this IDE load only" true: a window reload builds a new empty
  // bus and the previous timeline is gone, because it never existed anywhere
  // but in this object. Do not move it to `globalState` or a file.
  const eventBus = new EventBus();
  context.subscriptions.push({
    dispose: () => {
      eventBus.dispose();
    },
  });
  // The proxy runs in its own process (VS Code spawns `launch-mcp.sh`), so its
  // events arrive over a local socket rather than by function call. Failing to
  // bind degrades the pane to this window's own events; it never fails
  // activation. See `event-sink.ts`.
  context.subscriptions.push(startEventSink(eventBus, log));
  registerEventViewerCommand(context, eventBus, log);

  const eventsViewProvider = new EventsViewProvider(eventBus, log);
  context.subscriptions.push(eventsViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fortmesa.events', eventsViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // "Signed-in user" is a WebviewView, not a TreeView (2026-09-03): its
  // inline sign-out confirmation and its inline expired-session prompt are
  // not expressible as tree items. (Its advanced access-token control moved
  // to the Settings webview on 2026-09-05.) See `identity-view.ts`.
  const identityViewProvider = new IdentityViewProvider(log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fortmesa.identity', identityViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const saferoomTreeProvider = new SaferoomLauncherTreeProvider();
  context.subscriptions.push(saferoomTreeProvider);
  context.subscriptions.push(
    vscode.window.createTreeView('fortmesa.saferoom', { treeDataProvider: saferoomTreeProvider }),
  );

  const refreshAllTrees = (): void => {
    scopesTreeProvider.refresh();
    identityViewProvider.refresh();
    saferoomTreeProvider.refresh();
  };

  registerIdeSyncCommands(context, repoRoot, log);
  registerSwitcherCommands(context, log, clientVersion);
  registerLoginCommand(context, log);
  registerSaferoomLauncherCommands(context, log);
  registerSaferoomSettingsCommand(context, repoRoot, log, clientVersion);
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.refresh', () => {
      // The Scopes view re-runs its live gateway scope fetch on every
      // fetchRows() call — firing both trees' change events (and re-posting
      // the Signed-in user view's state) here re-reads every visible view,
      // so "refresh" and "re-run the live probes" are the same action.
      refreshAllTrees();
      log.info('fortmesa.refresh: Saferoom views refreshed (re-runs the live scope fetch)');
    }),
  );

  const reconciliation = startSettingsReconciliation(context, log);
  context.subscriptions.push(reconciliation);

  // Identity changes reach the same fan-out `applyConfig` owns.
  //
  // They have to be a separate signal because `watchConfig` watches
  // **config.json**, while signing in, signing out and pasting a token all
  // write **credentials.json** — which nothing watches, and deliberately
  // should not (it holds bearer tokens, and a silent token refresh is not an
  // identity change). Before this, a sign-out refreshed only the Signed-in
  // user view; the Scope selector, the status bar and an open Accessible
  // scopes panel went on rendering the previous identity's scopes.
  context.subscriptions.push(disposeIdentityEvents());
  context.subscriptions.push(
    onIdentityChanged((change) => {
      log.info(`identity changed for "${change.env}" (${change.kind}) — refreshing every Saferoom surface`);
      // The auth half of the timeline is produced HERE, not by the proxy: the
      // sign-in/sign-out flows run in the extension host, so they publish
      // straight into the bus with no wire involved. `change.env` is a
      // configured environment name (`prod`, `sandbox`), never a credential —
      // and it is dropped rather than rendered, because the pane's subject is
      // the action, not which environment it happened in.
      eventBus.publish({
        id: newEventId(),
        ts: Date.now(),
        kind: change.kind === 'signed-out' ? 'auth.signout' : 'auth.signin',
        family: 'auth',
        method: change.kind === 'signed-out' ? 'sign_out' : 'sign_in',
        outcome: 'ok',
      });
      refreshAllTrees();
      // The status bar's "Not signed-in" state is credentials.json-derived
      // and this event fires exactly when that file changed — config.json
      // did not, so `applyConfig` never runs on a plain sign-in/out. Only
      // repaint when the change is for the currently active env; a change to
      // some other configured env's credentials doesn't affect what the bar
      // is showing right now.
      if (change.env === currentConfig?.activeEnv) {
        refreshStatusBarForActiveEnv(currentConfig);
      }
      refreshSaferoomSettingsIfOpen(clientVersion, log);
      // The scope panel subscribes to the same event ITSELF, because it needs
      // more than a repaint: it resets its sync machine and shows a notice.
      // Not called here, so the reload does not happen twice.
    }),
  );

  // Reflect config.json state (scope lock) into the status bar, all three
  // tree views, and the live MCP provider's change signal — on the initial
  // load AND on every subsequent hot-reload-triggering write, whether made
  // by this VSIX's own settings reconciliation, the CLI, or a hand-edit.
  //
  // Additionally (R3/F4, plan amendment A1): run an IDE-sync pass on
  // activation (the first call — `previousIdeSync` is still `undefined`) and
  // whenever the `ideSync.*` flags themselves differ from the previous call
  // — never on every config change, since env/scope switches don't affect
  // the (byte-stable-by-design) IDE projections. `applyConfig` itself stays
  // synchronous, as it already was: the sync pass is fired-and-forgotten
  // with a `.catch()` so a slow or failing sync can never block VS Code's
  // config-watch callback.
  // Reads credentials.json for the active env and repaints the status bar
  // (both the main "Not signed-in"/"<scope>"/"Connected" text and the
  // expired-credential warning hint) from it. Shared between `applyConfig`
  // (config.json changes: env switch, scope-lock changes) and the identity
  // event listener below (credentials.json changes: sign in/out, paste a
  // token) — those are two different files with two different watchers
  // (see `registry/identity-events.ts`'s doc comment), but the status bar's
  // "signed in?" half of its text can only be answered by reading
  // credentials.json, so both paths funnel through here. Fired-and-forgotten
  // by both callers for the same reason: they run inside synchronous
  // VS-Code-driven callbacks (config-watch, identity-change fan-out) that
  // must not block on I/O. A failure to read credentials.json degrades to
  // "not signed in" — the least misleading assumption when the file's state
  // is genuinely unknown — rather than asserting a status it could not
  // confirm.
  const refreshStatusBarForActiveEnv = (config: Config): void => {
    void readCredentialsSummary(config.activeEnv)
      .then((summary) => {
        const signedIn = summary.hasToken && summary.expired !== true;
        const state: StatusBarScopeState = { signedIn, mode: config.scopeLock.mode, scopes: config.scopeLock.scopes };
        statusBar.update(state);
        statusBar.setSessionExpired(
          summary.expired === true ? expiredSessionNotice(config.activeEnv).statusBarTooltip : undefined,
        );
      })
      .catch((error: unknown) => {
        statusBar.update({ signedIn: false, mode: config.scopeLock.mode, scopes: config.scopeLock.scopes });
        statusBar.setSessionExpired(undefined);
        log.warn(`could not check credential expiry for the status bar: ${errorMessage(error)}`);
      });
  };

  let previousIdeSync: Config['ideSync'] | undefined;
  const applyConfig = (config: Config): void => {
    currentConfig = config;
    log.setLevel(config.logLevel);
    refreshStatusBarForActiveEnv(config);
    refreshAllTrees();
    mcpProvider.fireChanged();
    refreshSaferoomSettingsIfOpen(clientVersion, log);
    refreshScopeSelectionIfOpen(clientVersion, log);

    if (ideSyncChanged(previousIdeSync, config.ideSync)) {
      void runSyncPass(repoRoot, log).catch((error: unknown) => {
        log.error(`ideSync-triggered sync pass failed unexpectedly: ${errorMessage(error)}`);
      });
    }
    previousIdeSync = config.ideSync;
  };

  try {
    applyConfig(await loadConfig());
  } catch (error) {
    log.error(`failed to load initial config.json: ${errorMessage(error)}`);
  }

  const configWatcher = watchConfig(applyConfig, (msg) => {
    log.warn(msg);
  });
  context.subscriptions.push({
    dispose: () => {
      configWatcher.close();
    },
  });

  log.info('FortMesa Saferoom activated');
}

export function deactivate(): void {
  outputChannel?.info('FortMesa Saferoom deactivating — VS Code will dispose all registered subscriptions.');
  outputChannel = undefined;
}
