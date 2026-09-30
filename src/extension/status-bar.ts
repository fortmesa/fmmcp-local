import * as vscode from 'vscode';
import type { Config } from '../registry/config.js';
import { readAuthState } from '../registry/auth-state.js';
import { onAuthRefreshed } from '../registry/identity-events.js';
import { expiredSessionNotice } from '../registry/session-status.js';
import { errorMessage, type Logger } from './logger.js';
import { scopeListTooltip, statusBarSummaryFor, type StatusBarScopeState } from '../registry/status-bar-summary.js';

export type { ScopeLockMode, StatusBarScopeState } from '../registry/status-bar-summary.js';

/**
 * The Saferoom status-bar item (UX-ROUND-2-PLAN.md W8, D-U2/U5):
 * `$(fortmesa-logo) GRC: <summary>`, e.g. `$(fortmesa-logo) GRC:
 * barsoommsp` — the FortMesa glyph (W11's contributed icon font, D-U2: the
 * status bar can't render arbitrary SVG, only text + codicons/contributed
 * icons; the icon id MUST be two segments `component-iconname` or VS Code
 * rejects the whole `contributes.icons` entry — D016), the `GRC` acronym
 * instead of the word "FortMesa", then a short connection summary. Drives
 * SCOPE, not environment (env moved into the W10 "Saferoom Settings"
 * webview) — Clicking it REVEALS the Scope selector view
 * (`fortmesa.scopes.focus`, the view-focus command VS Code generates for
 * every contributed view) rather than opening a quickpick — the
 * 2026-09-03 UX round removed `fortmesa.switchScope` outright, because the
 * view's own rows are the selection and a palette dropdown detached from
 * the click was the exact complaint.
 *
 * The icon and the "GRC:" prefix are always present; only the text after
 * them changes (`statusBarSummaryFor`, `../registry/status-bar-summary.ts`,
 * PO 2026-09-09 — kept `vscode`-free there so it's unit-testable with plain
 * Node, same reasoning as `registry/identity-events.ts`).
 */

export interface StatusBarHandle {
  update(state: StatusBarScopeState): void;
  /**
   * Surface an expired credential as a status-bar hint (PO, 2026-09-05).
   *
   * The main text is left alone — `update()` already says "Not signed-in"
   * once the credential is actually expired — and the hint is a warning
   * glyph plus the warning background, with the tooltip carrying the
   * sentence. Passing `undefined` clears it. This is a HINT: the actual
   * prompt and its one-click recovery live in the Signed-in user pane, which
   * is where the user can act.
   */
  setSessionExpired(tooltip: string | undefined): void;
  dispose(): void;
}

export function createStatusBar(context: vscode.ExtensionContext): StatusBarHandle {
  const item = vscode.window.createStatusBarItem('fortmesa.statusBar', vscode.StatusBarAlignment.Left, 100);
  item.name = 'FortMesa Saferoom';
  item.command = 'fortmesa.scopes.focus';
  item.text = '$(fortmesa-logo) GRC: loading…';
  item.tooltip = 'FortMesa Saferoom — click to open the Scope selector';
  item.show();
  context.subscriptions.push(item);

  const DEFAULT_TOOLTIP = 'FortMesa Saferoom — click to open the Scope selector';
  let summary = 'loading…';
  let scopeTooltip: string | undefined;
  let expiredTooltip: string | undefined;

  const paint = (): void => {
    const expired = expiredTooltip;
    item.text = `${expired !== undefined ? '$(warning) ' : ''}$(fortmesa-logo) GRC: ${summary}`;
    if (expired !== undefined) {
      item.tooltip = `${expired} — click to open the Scope selector`;
    } else if (scopeTooltip !== undefined) {
      item.tooltip = `FortMesa Saferoom — ${scopeTooltip} — click to open the Scope selector`;
    } else {
      item.tooltip = DEFAULT_TOOLTIP;
    }
    item.backgroundColor = expired !== undefined ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };

  return {
    update(state: StatusBarScopeState): void {
      summary = statusBarSummaryFor(state);
      scopeTooltip = state.mode === 'unlocked' ? undefined : scopeListTooltip(state.scopes);
      paint();
    },
    setSessionExpired(tooltip: string | undefined): void {
      if (tooltip === expiredTooltip) return;
      expiredTooltip = tooltip;
      paint();
    },
    dispose(): void {
      item.dispose();
    },
  };
}

/**
 * Owns the "what does the bar say about the credential" half of the status
 * bar: reads auth state for the active env and repaints `statusBar`. Extracted
 * from `extension.ts` so the sequence (expired token, sidebar refresh, bar
 * state) can be driven through a real entry point.
 *
 * A failure to read credentials.json degrades to "not signed in" — the least
 * misleading assumption when the file's state is genuinely unknown.
 */
export interface StatusBarController {
  /** Repaint from credentials.json for `config.activeEnv`. Fire-and-forget; resolves when painted (tests await it). */
  refresh(config: Config): Promise<void>;
  dispose(): void;
}

export function createStatusBarController(statusBar: StatusBarHandle, log: Logger): StatusBarController {
  let lastConfig: Config | undefined;

  const refresh = (config: Config): Promise<void> => {
    lastConfig = config;
    return readAuthState(config.activeEnv)
      .then((auth) => {
        statusBar.update({ signedIn: auth.signedIn, mode: config.scopeLock.mode, scopes: config.scopeLock.scopes });
        statusBar.setSessionExpired(auth.expired ? expiredSessionNotice(config.activeEnv).statusBarTooltip : undefined);
      })
      .catch((error: unknown) => {
        statusBar.update({ signedIn: false, mode: config.scopeLock.mode, scopes: config.scopeLock.scopes });
        statusBar.setSessionExpired(undefined);
        log.warn(`could not check credential expiry for the status bar: ${errorMessage(error)}`);
      });
  };

  // A refresh started anywhere else (the Signed-in user pane, a scope fetch)
  // rewrote credentials.json under us: repaint from it (MFDV-581).
  const subscription = onAuthRefreshed((env) => {
    const config = lastConfig;
    if (config?.activeEnv === env) void refresh(config);
  });

  return {
    refresh,
    dispose(): void {
      subscription.dispose();
    },
  };
}
