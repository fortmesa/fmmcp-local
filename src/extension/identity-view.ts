import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { resolveCredentials } from '../local-mcp/auth/token-provider.js';
import { loadConfig, type Config } from '../registry/config.js';
import {
  decodeJwtExpiry,
  decodeJwtSubject,
  fetchIdentity,
  formatExactExpiry,
  formatRelativeExpiry,
  identityPrimaryLabel,
  readCurrentToken,
  readRefreshToken,
  type Identity,
} from '../registry/credentials.js';
import { clearCredentialAction, credentialKind } from '../registry/credential-kind.js';
import { environmentLabel } from '../registry/environments.js';
import {
  expiredSessionNotice,
  hasOAuthSignIn,
  isSessionExpired,
  type SessionRecovery,
} from '../registry/session-status.js';
import { signOutOfEnvironment } from './auth-commands.js';
import { notifyIdentityChanged } from '../registry/identity-events.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * The **Signed-in user** view (`fortmesa.identity`) — a sidebar
 * `WebviewView`, not the `TreeDataProvider` it was until 2026-09-03.
 *
 * Why the view type changed. Three PO rulings landed on this one section and
 * none of them is expressible in a TreeView:
 *
 *  1. Sign-out loses its modal, because a modal in an MDI app "may not even
 *     be on the same monitor or lost underneath windows". It briefly gained
 *     an inline confirmation strip instead; 2026-09-08 the PO removed that
 *     too — *"this one doesn't even need confirmation. Just sign out when
 *     clicking sign out even if this means destroying an M2M token."* One
 *     click acts. What survives of the warning is the LABEL: a pasted access
 *     token's button reads **Remove**, not Sign out, because clearing it from
 *     this editor does not revoke it (see `registry/credential-kind.ts`; no
 *     revocation endpoint is called — PO: not asked for).
 *  2. Signing in is the DEFAULT, not one option among several: signed out,
 *     this pane is a single primary "Sign in" button.
 *  3. An expired credential must PROMPT here rather than sit as a muted
 *     "expires expired" suffix (PO, 2026-09-05) — an inline "Session
 *     expired" state with a one-click recovery, no modal.
 *
 * The access-token control that used to live here as an inline "Advanced"
 * expansion moved to the **Settings** webview's Identity section
 * (`saferoom-settings.ts`, "Advanced" expansion) on PO instruction
 * (2026-09-05: "advanced paste an access token form should be exposed in the
 * settings section via an advanced expansion (not in the sidebar view)").
 * This pane now carries sign-in, sign-out and identity only. The CLI
 * `token set` path is unchanged and remains the third route.
 *
 * Bridge contract (webview <-> extension host via `postMessage`):
 *   webview -> host: { type: 'getState' }
 *                    { type: 'signIn' }
 *                    { type: 'signOut' }                      // already confirmed inline
 *                    { type: 'openTokenSettings' }            // token-only env: Settings > Advanced
 *   host -> webview: { type: 'state', payload: IdentityViewState }
 * As in the Settings webview, every mutating message is answered with a
 * freshly-read state — never an optimistic echo.
 *
 * No token string travels through this pane in either direction any more —
 * the control that accepted one now lives in the Settings webview.
 */

interface DetailField {
  readonly label: string;
  readonly value: string;
}

/** The inline expired-session prompt, present only while the stored credential is provably dead. */
interface ExpiredView {
  readonly message: string;
  readonly actionLabel: string;
  readonly action: SessionRecovery;
  readonly detail: string;
}

interface IdentityViewState {
  readonly signedIn: boolean;
  /** Headline: the real user when `/api/v2/me` answered, else a status line. */
  readonly primary: string;
  readonly secondary?: string;
  /**
   * Relative time to expiry — already a complete phrase, e.g. "expires in 4 h"
   * (`formatRelativeExpiry`). Rendered verbatim next to the name; the webview
   * must NOT prefix it with another "expires", which is exactly the doubled
   * word the PO reported on 2026-09-10.
   */
  readonly relativeExpiry?: string;
  readonly details: readonly DetailField[];
  /**
   * Identity provider and token id, as a hover on the headline. They were
   * tree ROWS until 2026-09-10, when the PO removed them from the card: they
   * are diagnostics, not identity, and they crowded out the four facts that
   * are. Still reachable on hover because they cost one attribute, and the
   * Settings > Identity table keeps them as rows.
   */
  readonly hoverDetail?: string;
  readonly activeEnv: string;
  readonly activeEnvLabel: string;
  /** Present ONLY when the stored credential has provably expired — the pane leads with this instead of the identity. */
  readonly expired?: ExpiredView;
  /** Label + tooltip for the clear-credential button: "Sign out" or "Remove", by credential kind. */
  readonly clearAction: { readonly label: string; readonly tooltip: string };
  readonly error?: string;
}

/** Is a refresh token stored for `env`? An unreadable credentials.json answers "no": this only picks a button label, and the label that assumes less is the right one to fall back to. */
async function hasStoredRefreshToken(env: string): Promise<boolean> {
  try {
    return (await readRefreshToken(env)) !== undefined;
  } catch {
    return false;
  }
}

/** The action pair used by the signed-out and failed-to-read states, where no credential exists to classify. Never rendered (the button is hidden), but the field is non-optional so every state answers the question. */
const NO_CLEAR_ACTION = { label: 'Sign out', tooltip: '' } as const;

/** Build the pane's whole state from config.json + credentials.json (+ a best-effort `/api/v2/me`). Never throws — failures become the `error` field so the pane degrades to a message instead of going blank. */
async function buildState(): Promise<IdentityViewState> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    return {
      signedIn: false,
      primary: 'Not signed in',
      details: [],
      activeEnv: 'prod',
      activeEnvLabel: environmentLabel('prod'),
      clearAction: NO_CLEAR_ACTION,
      error: `Failed to load config.json: ${errorMessage(error)}`,
    };
  }

  const env = config.activeEnv;
  const envLabel = environmentLabel(env);

  let token: string | undefined;
  try {
    token = await readCurrentToken(env);
  } catch (error) {
    return {
      signedIn: false,
      primary: 'Not signed in',
      details: [],
      activeEnv: env,
      activeEnvLabel: envLabel,
      clearAction: NO_CLEAR_ACTION,
      error: `Failed to read credentials.json: ${errorMessage(error)}`,
    };
  }

  if (token === undefined) {
    return {
      signedIn: false,
      primary: 'Not signed in',
      secondary: envLabel,
      details: [],
      activeEnv: env,
      activeEnvLabel: envLabel,
      clearAction: NO_CLEAR_ACTION,
    };
  }

  // Best-effort enrichment with the real signed-in user (MFDV-244). Degrades
  // silently to the token-only display when `/api/v2/me` is unavailable
  // (404 off-sandbox, unreachable, missing creds).
  let identity: Identity | undefined;
  try {
    const creds = await resolveCredentials(env);
    identity = await fetchIdentity(creds.baseUrl, creds.token);
  } catch {
    identity = undefined;
  }

  // The decoded `sub` claim is this token's only identity-shaped JWT field —
  // the per-token identifier (the OidcAuth token-record id), kept as a
  // secondary detail rather than a headline.
  const sub = decodeJwtSubject(token);
  const expiry = decodeJwtExpiry(token);

  // An expired credential is a PROMPT, not a footnote (PO, 2026-09-05). The
  // pane keeps every identity detail — the user still wants to see whose
  // session died and when — but leads with the recovery. `signedIn` stays
  // false so the sign-out button is replaced by the recovery action: there
  // is nothing left to sign out of.
  const expired = isSessionExpired(expiry);
  const notice = expired ? expiredSessionNotice(env) : undefined;

  // "Sign out" vs "Remove" — decided from the credential, not from a guess in
  // the markup. A stored refresh token is the only positive evidence of an
  // interactive sign-in; anything else under-promises. See credential-kind.ts.
  const clearAction = clearCredentialAction(
    credentialKind({ hasRefreshToken: await hasStoredRefreshToken(env), envHasOAuthSignIn: hasOAuthSignIn(env) }),
    envLabel,
  );

  // The two rows the PO removed, kept as a headline hover.
  const provider = identity?.identityProvider;
  const hoverParts = [
    ...(provider !== undefined && provider.length > 0 ? [`Identity provider: ${provider}`] : []),
    ...(sub !== undefined ? [`Token ID: ${sub}`] : []),
  ];
  const hoverDetail = hoverParts.length > 0 ? hoverParts.join(' \u00b7 ') : undefined;

  return {
    signedIn: !expired,
    primary:
      notice !== undefined ? notice.headline : identity !== undefined ? identityPrimaryLabel(identity) : 'Signed in',
    ...(identity !== undefined ? { secondary: identity.email } : {}),
    relativeExpiry: formatRelativeExpiry(expiry),
    // Data region and Expires ONLY (PO, 2026-09-10). `formatExactExpiry`
    // renders in the host's locale and local time zone, and now names the
    // zone, so "9/10/2026, 6:35:07 PM EDT" cannot be misread as UTC.
    details: [
      { label: 'Data region', value: envLabel },
      { label: 'Expires', value: formatExactExpiry(expiry) },
    ],
    ...(hoverDetail !== undefined ? { hoverDetail } : {}),
    activeEnv: env,
    activeEnvLabel: envLabel,
    clearAction,
    ...(notice !== undefined
      ? {
          expired: {
            message: notice.message,
            actionLabel: notice.actionLabel,
            action: notice.action,
            detail: notice.detail,
          },
        }
      : {}),
  };
}

type InboundMessage =
  | { readonly type: 'getState' }
  | { readonly type: 'signIn' }
  | { readonly type: 'signOut' }
  | { readonly type: 'openTokenSettings' };

function isInboundMessage(value: unknown): value is InboundMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/**
 * A CSP nonce is a security token, so it must be unpredictable. This used to be a
 * non-cryptographic PRNG loop inherited from the VS Code webview sample, which is not
 * a CSPRNG. It matters because nonce-based CSP (no `'unsafe-inline'`) is the only thing
 * containing an injected attribute in these panels.
 */
function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The pane's markup. Deliberately small since the advanced token control
 * moved to Settings (2026-09-05): identity, one primary action, the inline
 * sign-out confirmation, and the inline expired-session prompt.
 */
function renderHtml(webview: vscode.Webview, cspNonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${cspNonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Signed-in user</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px 16px; font-size: 12px; }
  .primary { font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .muted { color: var(--vscode-descriptionForeground); font-weight: normal; }
  table.details { border-collapse: collapse; margin: 6px 0 10px; }
  table.details td { padding: 1px 8px 1px 0; vertical-align: top; }
  table.details td.field { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  table.details td.value { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; font-family: inherit; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .expired { border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border, transparent)); background: var(--vscode-inputValidation-warningBackground, transparent); padding: 8px; border-radius: 2px; margin: 8px 0; }
  .expired .message { font-weight: 600; }
  .expired .detail { margin-top: 4px; line-height: 1.45; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div id="loadError" class="status error" hidden></div>

  <div class="primary"><span id="primary"></span><span id="expiry" class="muted"></span></div>
  <div id="secondary" class="muted"></div>

  <table class="details"><tbody id="details"></tbody></table>

  <div class="expired" id="expired" hidden>
    <div class="message" id="expiredMessage"></div>
    <div class="detail muted" id="expiredDetail"></div>
    <div class="actions"><button id="expiredAction"></button></div>
  </div>

  <div class="actions" id="signedOutActions" hidden>
    <button id="signIn">Sign in</button>
  </div>

  <div class="actions" id="signedInActions" hidden>
    <button id="signOut" class="secondary">Sign out</button>
  </div>


<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  let lastState = null;

  const $ = (id) => document.getElementById(id);

  function render(state) {
    lastState = state;

    const loadError = $('loadError');
    loadError.hidden = !state.error;
    loadError.textContent = state.error || '';

    $('primary').textContent = state.primary;
    $('primary').title = state.hoverDetail || '';
    // relativeExpiry ALREADY reads "expires in 4 h" -- prefixing "expires"
    // here is what produced "expires expires in 4 h" (PO, 2026-09-10).
    $('expiry').textContent = state.relativeExpiry ? '\\u00b7 ' + state.relativeExpiry : '';
    $('secondary').textContent = state.secondary || '';

    const details = $('details');
    details.textContent = '';
    for (const field of state.details) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.className = 'field';
      td1.textContent = field.label;
      const td2 = document.createElement('td');
      td2.className = 'value';
      td2.textContent = field.value;
      tr.appendChild(td1);
      tr.appendChild(td2);
      details.appendChild(tr);
    }

    // An expired session replaces BOTH action rows: signing out of a dead
    // credential is meaningless, and the plain "Sign in" button would not
    // say why it is suddenly needed.
    const expired = state.expired || null;
    $('expired').hidden = !expired;
    $('expiredMessage').textContent = expired ? expired.message : '';
    $('expiredDetail').textContent = expired ? expired.detail : '';
    $('expiredAction').textContent = expired ? expired.actionLabel : '';

    $('signedOutActions').hidden = state.signedIn || !!expired;
    $('signedInActions').hidden = !state.signedIn;

    // Label and tooltip come from the host, by credential kind: an
    // interactive session says "Sign out", a pasted access token says
    // "Remove" -- clearing it here does not revoke it.
    $('signOut').textContent = state.clearAction.label;
    $('signOut').title = state.clearAction.tooltip;
  }

  $('expiredAction').addEventListener('click', () => {
    const expired = lastState ? lastState.expired : null;
    if (!expired) return;
    vscode.postMessage({ type: expired.action === 'update-token' ? 'openTokenSettings' : 'signIn' });
  });

  $('signIn').addEventListener('click', () => { vscode.postMessage({ type: 'signIn' }); });

  // No confirmation (PO, 2026-09-08): one click acts. The only warning is the
  // button's own label and tooltip, which say plainly that removing a pasted
  // access token leaves the token itself valid.
  $('signOut').addEventListener('click', () => { vscode.postMessage({ type: 'signOut' }); });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'state') {
      render(message.payload);
    }
  });

  vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}

/**
 * `WebviewViewProvider` for `fortmesa.identity`. Registered (and refreshed)
 * from `extension.ts`; `refresh()` re-reads state and pushes it to the
 * webview if one is currently resolved, which is how the config watcher,
 * `fortmesa.refresh` and this pane's own actions all keep it current.
 */
export class IdentityViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly log: Logger) {}

  refresh(): void {
    void this.postState();
  }

  private async postState(): Promise<void> {
    const view = this.view;
    if (view === undefined) return;
    const state = await buildState();
    await view.webview.postMessage({ type: 'state', payload: state });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml(webviewView.webview, nonce());

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.log.error(`Signed-in user view: message handling failed unexpectedly: ${errorMessage(error)}`);
      });
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isInboundMessage(message)) return;

    switch (message.type) {
      case 'getState':
        await this.postState();
        return;

      case 'signIn':
        await vscode.commands.executeCommand('fortmesa.login');
        await this.postState();
        return;

      case 'signOut': {
        const env = (await loadConfig()).activeEnv;
        const cleared = await signOutOfEnvironment(env);
        this.log.info(
          cleared
            ? `Signed-in user view: cleared the stored token for "${env}"`
            : `Signed-in user view: sign-out requested for "${env}" but nothing was stored`,
        );
        await this.postState();
        // ...and tell everything else. This handler used to refresh THIS view
        // and nothing else: the Scope selector tree, the status bar and an
        // open Accessible scopes panel all kept rendering the signed-out
        // identity's scopes, because the only refresh fan-out that reaches
        // them is driven by a config.json watcher and this writes
        // credentials.json. See `identity-events.ts`.
        notifyIdentityChanged({ kind: 'signed-out', env });
        return;
      }

      case 'openTokenSettings':
        // Token-only environments have no sign-in to re-run, so the recovery
        // is the access-token control — which now lives in Settings.
        await vscode.commands.executeCommand('fortmesa.openSaferoomSettings');
        return;
    }
  }
}
