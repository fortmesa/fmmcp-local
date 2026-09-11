import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { loadConfig } from '../registry/config.js';
import {
  initialSignInPageModel,
  projectSignInPage,
  reduceSignInPage,
  type SignInPageAction,
  type SignInPageButtonId,
  type SignInPageEffect,
  type SignInPageModel,
  type SignInPageSessionEvent,
} from '../registry/sign-in-page-state.js';
import type { Logger } from './logger.js';
import {
  resolveSignInLanding,
  startSignIn,
  type SignInEvent,
  type SignInMethodMemory,
  type SignInSession,
} from './sign-in-session.js';

/**
 * **The** sign-in surface (PLAN-vsix-signin.md §3.1, BRIEF-SIGNIN-2).
 *
 * PO constraint, and the reason this file exists: *every* sign-in question is
 * asked on this page. No `showInputBox`, no `showQuickPick`, no modal, no
 * palette prompt anywhere on the sign-in path — including the API-base
 * question for an environment Saferoom does not ship, which used to be an
 * input box in `login-command.ts` and is now a field here. Commands only OPEN
 * this page; they never collect anything themselves.
 *
 * Both methods are on the page at once, always, as a `role="radiogroup"` of
 * two cards. The extension pre-selects one from the detected topology
 * (`chooseDefaultMethod`) and says nothing about why — the paste method is
 * never hidden, because hiding it is precisely what strands a user whose
 * browser cannot reach this editor, and neither card is ever dimmed or
 * `aria-disabled`, because the previous shape announced the unselected card as
 * inert while it held the only working control on the page (SIGNIN-9).
 *
 * Structure: this file owns the panel, the HTML and the session; every state,
 * transition and word of copy lives in the pure `registry/sign-in-page-state.ts`
 * so the whole of PLAN §3.1 is unit-testable without an extension host.
 *
 * Bridge contract (webview <-> extension host via `postMessage`):
 *   webview -> host:  { type: 'ready' }
 *                     { type: 'button', id: SignInPageButtonId }
 *                     { type: 'selectMethod', method: SignInMethod }
 *                     { type: 'setApiBase', value: string }
 *                     { type: 'paste', text: string }
 *                     { type: 'back' }
 *   host -> webview:  { type: 'view', payload: SignInPageView }
 * The webview renders ONLY from the most recent `view` message — it holds no
 * state of its own and composes no copy.
 */

let activePanel: vscode.WebviewPanel | undefined;

/** A CSP nonce is a security token: it must come from a CSPRNG, never a non-cryptographic PRNG (security-delta F-2). */
function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * A webview posts arbitrary JSON: the host must NARROW it rather than declare
 * a union and trust that the sender honoured it. So the inbound message is
 * typed `Record<string, unknown>` and each field is checked where it is read —
 * a declared union here would make every one of those checks look redundant to
 * the type checker while changing nothing about what can actually arrive.
 */
type InboundMessage = Record<string, unknown> & { readonly type: string };

function isInboundMessage(value: unknown): value is InboundMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

const BUTTON_IDS: ReadonlySet<string> = new Set<string>([
  'continue',
  'switch',
  'fresh',
  'open-token-settings',
  'complete-paste',
  'copy-link',
  'done',
  'keep',
  'try-again',
  'use-different',
]);

/**
 * The extension's `SignInEvent` must remain assignable to the pure module's
 * event union. Asserted at compile time rather than trusted, because the two
 * are declared in different files on purpose (`registry/**` may not import
 * `vscode`) and a drift between them would otherwise surface as a page that
 * silently stops updating.
 */
const asPageEvent: (event: SignInEvent) => SignInPageSessionEvent = (event) => event;

/** Everything mutable about one open page. */
interface PageRuntime {
  model: SignInPageModel;
  session: SignInSession | undefined;
  subscription: vscode.Disposable | undefined;
  /** Bumped whenever a session is released or abandoned; a listener from an older session is ignored. */
  sessionToken: number;
}

const BUTTON_ACTIONS: Partial<Record<SignInPageButtonId, SignInPageAction>> = {
  fresh: { type: 'start', intent: { mode: 'fresh' } },
  'copy-link': { type: 'copy-link' },
  done: { type: 'done' },
  keep: { type: 'keep-account' },
  'try-again': { type: 'restart' },
};

/**
 * Open (or re-reveal) the sign-in page. Single instance: a second invocation
 * reveals the existing panel rather than starting a competing sign-in, which
 * would race two loopback listeners for the same port.
 */
export async function openSignInPage(
  context: vscode.ExtensionContext,
  memory: SignInMethodMemory,
  log: Logger,
): Promise<void> {
  if (activePanel !== undefined) {
    activePanel.reveal();
    return;
  }

  const config = await loadConfig();
  const env = config.activeEnv;
  const landing = await resolveSignInLanding(env, memory);

  const panel = vscode.window.createWebviewPanel('fortmesa.signIn', 'Sign In to FortMesa', vscode.ViewColumn.One, {
    enableScripts: true,
    // The sign-in is a long wait with a live countdown; letting the webview be
    // torn down when the user looks at a file would drop the running session's
    // rendered state on the floor.
    retainContextWhenHidden: true,
  });
  activePanel = panel;
  panel.webview.html = renderSignInPageHtml(panel.webview, nonce());

  const runtime: PageRuntime = {
    model: initialSignInPageModel(env, landing),
    session: undefined,
    subscription: undefined,
    sessionToken: 0,
  };

  const post = (): void => {
    void panel.webview.postMessage({ type: 'view', payload: projectSignInPage(runtime.model) });
  };

  /**
   * Drop the current session's listener. Disposal is DEFERRED: `onEvent`
   * replays synchronously, so a terminal event can reach this while the
   * listener is still on the stack, and disposing a handle from inside its own
   * callback throws.
   */
  const release = (): void => {
    const subscription = runtime.subscription;
    runtime.subscription = undefined;
    runtime.session = undefined;
    runtime.sessionToken += 1;
    if (subscription !== undefined)
      queueMicrotask(() => {
        subscription.dispose();
      });
  };

  const dispatch = (action: SignInPageAction): void => {
    const { model, effects } = reduceSignInPage(runtime.model, action);
    runtime.model = model;
    for (const effect of effects) applyEffect(effect);
    post();
  };

  const applyEffect = (effect: SignInPageEffect): void => {
    switch (effect.kind) {
      case 'start-sign-in': {
        release();
        const token = runtime.sessionToken;
        const session = startSignIn(env, effect.intent, effect.method, log, {
          ...(effect.apiBase !== undefined ? { apiBase: effect.apiBase } : {}),
          memory,
        });
        runtime.session = session;
        // `let` + a deferred dispose: `onEvent` replays `waiting` (and any
        // already-terminal event) SYNCHRONOUSLY, so `subscription` may still
        // be unassigned while the first events arrive.
        const subscription = session.onEvent((event) => {
          if (token !== runtime.sessionToken) return;
          dispatch({ type: 'session', event: asPageEvent(event) });
        });
        if (token === runtime.sessionToken) {
          runtime.subscription = subscription;
        } else {
          // A terminal event already released this session during the replay.
          queueMicrotask(() => {
            subscription.dispose();
          });
        }
        return;
      }
      case 'submit-paste':
        runtime.session?.submitPasted(effect.text);
        return;
      case 'abandon-session': {
        const session = runtime.session;
        release();
        session?.cancel();
        return;
      }
      case 'copy-link':
        void runtime.session?.copyLink();
        return;
      case 'release-session':
        release();
        return;
      case 'close-panel':
        void vscode.commands.executeCommand('fortmesa.refresh');
        panel.dispose();
        return;
    }
  };

  const handleButton = (id: SignInPageButtonId): void => {
    if (id === 'open-token-settings') {
      void vscode.commands.executeCommand('fortmesa.openSaferoomSettings');
      return;
    }
    if (id === 'continue') {
      const email = runtime.model.cachedIdentity?.email;
      dispatch(
        email !== undefined
          ? { type: 'start', intent: { mode: 'continue', email } }
          : { type: 'start', intent: { mode: 'fresh' } },
      );
      return;
    }
    if (id === 'switch' || id === 'use-different') {
      // "Use a different account" starts the SELECTED method with
      // `prompt=login` (see `authorizeIntentParams`), so Auth0 shows the login
      // form instead of silently handing back the SSO session the user is
      // trying to leave. On the code-based card that means re-preparing the
      // session so its link field carries the new intent.
      dispatch({ type: 'start', intent: { mode: 'switch' } });
      return;
    }
    if (id === 'complete-paste') return; // the webview sends the text with a `paste` message instead.
    const action = BUTTON_ACTIONS[id];
    if (action !== undefined) dispatch(action);
  };

  panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      if (!isInboundMessage(message)) return;
      switch (message.type) {
        case 'ready':
          post();
          return;
        case 'selectMethod': {
          const method = message.method;
          if (method !== 'browser' && method !== 'paste') return;
          dispatch({ type: 'select-method', method });
          return;
        }
        case 'setApiBase': {
          const value = message.value;
          if (typeof value !== 'string') return;
          dispatch({ type: 'set-api-base', value });
          return;
        }
        case 'paste': {
          const text = message.text;
          if (typeof text !== 'string') return;
          dispatch({ type: 'submit-paste', text });
          return;
        }
        case 'back':
          dispatch({ type: 'back' });
          return;
        case 'button': {
          const id = message.id;
          if (typeof id !== 'string' || !BUTTON_IDS.has(id)) return;
          handleButton(id as SignInPageButtonId);
          return;
        }
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(
    () => {
      // A page closed mid-flight must not leave a loopback listener bound: the
      // port is a process-wide resource and the next attempt would fall
      // through to the next candidate port for no reason.
      runtime.session?.cancel();
      release();
      activePanel = undefined;
    },
    undefined,
    context.subscriptions,
  );

  log.info(
    `fortmesa sign-in page: opened for env "${env}" (method "${landing.choice.method}", ${landing.choice.reason}).`,
  );
  post();
}

/**
 * The page's markup and its client script.
 *
 * Nonce-based CSP with no `'unsafe-inline'` for scripts (security-delta F-2),
 * `--vscode-*` theme variables throughout so the page inherits the user's
 * theme, and `escapeHtml` on **every** interpolation in the client script
 * (F-1) — the strings it renders include an email address and an error message
 * from a remote authorization server.
 */
export function renderSignInPageHtml(webview: Pick<vscode.Webview, 'cspSource'>, cspNonce: string): string {
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
<title>Sign in to FortMesa</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 16px; max-width: 620px; }
  .headline { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .region { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 18px; }
  .message { line-height: 1.5; margin: 12px 0; }
  .notice { border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border, transparent)); background: var(--vscode-inputValidation-warningBackground, transparent); padding: 8px 10px; border-radius: 2px; line-height: 1.45; }
  /* The identity the machine already knows, above the chooser. */
  .identity { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; margin-bottom: 14px; }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .identity-text { min-width: 0; flex: 1; }
  .identity-name { font-weight: 600; }
  .identity-sub { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-heading { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 22px 0 8px; }
  /* The whole card is the radio, and it CARRIES ITS OWN ACTIONS. Nothing here
     is dimmed and nothing is disabled: the unselected method is a real,
     legible choice showing only its title and its requirement, so selecting a
     card can grow that card and never the page above it. */
  .card { position: relative; display: block; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; padding: 10px 34px 10px 12px; margin-bottom: 8px; cursor: pointer; }
  .card:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .card.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, transparent); }
  .card .card-title { font-weight: 600; }
  .card .card-requirement { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 3px; line-height: 1.45; }
  .card .card-check { position: absolute; top: 9px; right: 12px; color: var(--vscode-focusBorder); font-weight: 600; }
  .card-body { margin-top: 12px; cursor: default; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-widget-border, transparent); padding: 4px 12px; cursor: pointer; border-radius: 2px; font-family: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
  button.link { background: transparent; color: var(--vscode-textLink-foreground); border: none; padding: 0; font-size: 12px; text-decoration: underline; }
  button.icon { background: transparent; border: 1px solid transparent; color: var(--vscode-foreground); padding: 3px; line-height: 0; flex: none; border-radius: 3px; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, transparent)); color: var(--vscode-foreground); }
  button.icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button.back { margin-left: -3px; }
  label.field-label { display: block; margin: 12px 0 3px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  input, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font-family: inherit; font-size: 12px; }
  input[readonly] { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); cursor: text; }
  .link-row { display: flex; align-items: center; gap: 6px; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; line-height: 1.45; }
  .detail { color: var(--vscode-descriptionForeground); font-size: 12px; margin: -4px 0 12px; line-height: 1.45; }
  .waiting-head { display: flex; align-items: center; gap: 8px; line-height: 1.5; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .countdown { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 6px; }
  .divider { border: none; border-top: 1px solid var(--vscode-widget-border, transparent); margin: 18px 0 14px; }
  .paste-prompt { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 10px 0 4px; line-height: 1.45; }
  .paste-submit { margin-top: 8px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="headline">
    <button class="icon back" id="back" hidden></button>
    <h1 id="title"></h1>
  </div>
  <div class="region" id="region"></div>

  <div class="notice" id="tokenOnly" hidden></div>
  <div class="message" id="message" hidden></div>
  <div class="detail" id="detail" hidden></div>

  <div id="apiBaseRow" hidden>
    <label class="field-label" for="apiBaseInput" id="apiBaseLabel"></label>
    <input type="text" id="apiBaseInput" placeholder="https://api.example.com" autocomplete="off" spellcheck="false" />
    <div class="error" id="apiBaseError" hidden></div>
  </div>

  <div class="identity" id="identity" hidden>
    <div class="avatar" id="identityInitials" aria-hidden="true"></div>
    <div class="identity-text">
      <div class="identity-name" id="identityName"></div>
      <div class="identity-sub" id="identitySub"></div>
    </div>
    <button class="link" id="identitySwitch"></button>
  </div>

  <div id="waiting" hidden>
    <div class="waiting-head"><span class="spinner" id="spinner" hidden></span><span id="waitingHeadline"></span></div>
    <div class="countdown" id="countdown" hidden></div>
    <hr class="divider" />
    <div class="paste-prompt" id="waitingLeadIn"></div>
    <div id="waitingSlot"></div>
  </div>

  <div id="methods" hidden>
    <div class="group-heading" id="methodsHeading">Choose how to sign in</div>
    <div id="cards" role="radiogroup" aria-labelledby="methodsHeading"></div>
  </div>

  <div class="actions" id="actions"></div>

<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  let view = null;
  let expiresAt = null;
  /** The paste box's text survives a re-render; the host never echoes it back. */
  let pasteDraft = '';
  let copyFlashUntil = 0;

  const COPY_ICON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="9" rx="1"></rect>' +
    '<path d="M10.5 3.5h-7a1 1 0 0 0-1 1v8"></path></svg>';
  const CHECK_ICON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
    '<path d="M3 8.5l3.5 3.5L13 5"></path></svg>';
  const BACK_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
    '<path d="M10 3L5 8l5 5"></path></svg>';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function $(id) { return document.getElementById(id); }

  function selectMethod(method) {
    if (!method) return;
    vscode.postMessage({ type: 'selectMethod', method: method });
  }

  // ── The two composable blocks a card and the waiting state both use ───────
  //
  // The read-only link field is NOT decoration: a copy button can fail
  // silently, and the field is what the user copies by hand when it does. It
  // shows the authorize URL, which carries client_id / state / the PKCE
  // challenge and never a code, a token or the verifier.

  function linkHtml(link) {
    if (!link) return '';
    return '<label class="field-label" for="linkInput">' + escapeHtml(link.label) + '</label>' +
      '<div class="link-row">' +
      '<input type="text" id="linkInput" readonly value="' + escapeHtml(link.value) + '" spellcheck="false" />' +
      '<button class="icon" id="copyLink" title="' + escapeHtml(link.copyLabel) + '"' +
      ' aria-label="' + escapeHtml(link.copyLabel) + '"></button>' +
      '</div>';
  }

  function pasteHtml(paste, promptId) {
    if (!paste) return '';
    if (paste.errorFatal) {
      return '<div class="error">' + escapeHtml(paste.error || '') + '</div>' +
        '<div class="actions"><button class="primary" data-id="try-again">' +
        escapeHtml(paste.retryLabel) + '</button></div>';
    }
    return (promptId ? '' : '<div class="paste-prompt">' + escapeHtml(paste.prompt) + '</div>') +
      '<input type="text" id="pasteInput" spellcheck="false" autocomplete="off"' +
      ' placeholder="' + escapeHtml(paste.placeholder) + '" value="' + escapeHtml(pasteDraft) + '" />' +
      '<div class="error" id="pasteError"' + (paste.error ? '' : ' hidden') + '>' +
      escapeHtml(paste.error || '') + '</div>' +
      '<div class="paste-submit"><button class="primary" id="pasteSubmit" data-id="complete-paste"' +
      (pasteDraft.trim() === '' ? ' hidden' : '') + '>' +
      escapeHtml(paste.submitting ? paste.submittingLabel : paste.submitLabel) + '</button></div>';
  }

  /** Wire whatever of the two blocks just landed in the root element. Idempotent per render. */
  function wireBlocks(root) {
    const copy = root.querySelector('#copyLink');
    if (copy) {
      copy.innerHTML = Date.now() < copyFlashUntil ? CHECK_ICON : COPY_ICON;
      copy.addEventListener('click', (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        vscode.postMessage({ type: 'button', id: 'copy-link' });
        copyFlashUntil = Date.now() + 1500;
        copy.innerHTML = CHECK_ICON;
        setTimeout(() => { copy.innerHTML = COPY_ICON; }, 1500);
      });
    }
    const link = root.querySelector('#linkInput');
    if (link) {
      // Select-all on focus AND on click, so Ctrl+C works whether the user
      // tabbed here or reached for the mouse.
      const selectAll = () => { if (link.select) link.select(); };
      link.addEventListener('focus', selectAll);
      link.addEventListener('click', selectAll);
    }
    const input = root.querySelector('#pasteInput');
    const submit = root.querySelector('#pasteSubmit');
    if (input) {
      input.addEventListener('click', (event) => { if (event && event.stopPropagation) event.stopPropagation(); });
      input.addEventListener('input', () => {
        pasteDraft = input.value;
        if (submit) submit.hidden = pasteDraft.trim() === '';
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        if (event.preventDefault) event.preventDefault();
        if (input.value.trim() === '') return;
        vscode.postMessage({ type: 'paste', text: input.value });
      });
    }
    if (submit) {
      submit.addEventListener('click', (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        vscode.postMessage({ type: 'paste', text: input ? input.value : pasteDraft });
      });
    }
    for (const retry of root.querySelectorAll('button[data-id]')) {
      if (retry.getAttribute('data-id') !== 'try-again') continue;
      retry.addEventListener('click', (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        vscode.postMessage({ type: 'button', id: 'try-again' });
      });
    }
  }

  // A radiogroup, not a list with a link in it. The whole card is the control,
  // neither card is ever disabled, arrow keys move AND select (the WAI-ARIA
  // radio pattern), and the SELECTED card carries the actions for its method —
  // there is no button row underneath applying to whichever card is current.
  function renderCards() {
    $('cards').innerHTML = view.cards
      .map((card) =>
        '<div class="card ' + (card.selected ? 'selected' : '') + '" role="radio"' +
        ' aria-checked="' + (card.selected ? 'true' : 'false') + '"' +
        ' tabindex="' + (card.selected ? '0' : '-1') + '"' +
        ' data-method="' + escapeHtml(card.method) + '">' +
        (card.selected ? '<span class="card-check" aria-hidden="true">✓</span>' : '') +
        '<div class="card-title">' + escapeHtml(card.title) + '</div>' +
        '<div class="card-requirement">' + escapeHtml(card.requirement) + '</div>' +
        (card.action || card.link || card.paste
          ? '<div class="card-body">' +
            (card.action
              ? '<div class="actions"><button class="' + (card.action.primary ? 'primary' : '') + '"' +
                ' data-id="' + escapeHtml(card.action.id) + '">' + escapeHtml(card.action.label) + '</button></div>'
              : '') +
            linkHtml(card.link) + pasteHtml(card.paste) +
            '</div>'
          : '') +
        '</div>',
      )
      .join('');

    const cards = Array.prototype.slice.call($('cards').querySelectorAll('[data-method]'));
    cards.forEach((card, index) => {
      card.addEventListener('click', () => { selectMethod(card.getAttribute('data-method')); });
      card.addEventListener('keydown', (event) => {
        const key = event.key;
        if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
          if (event.preventDefault) event.preventDefault();
          selectMethod(card.getAttribute('data-method'));
          return;
        }
        let delta = 0;
        if (key === 'ArrowDown' || key === 'ArrowRight') delta = 1;
        else if (key === 'ArrowUp' || key === 'ArrowLeft') delta = -1;
        else return;
        if (event.preventDefault) event.preventDefault();
        if (cards.length === 0) return;
        const next = cards[(index + delta + cards.length) % cards.length];
        if (next.focus) next.focus();
        selectMethod(next.getAttribute('data-method'));
      });
    });
    // The card's own action buttons: started AFTER the card handler so a click
    // on a button does not also re-select the card it sits in.
    for (const button of $('cards').querySelectorAll('button[data-id]')) {
      const id = button.getAttribute('data-id');
      if (id === 'complete-paste' || id === 'try-again') continue;
      button.addEventListener('click', (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        vscode.postMessage({ type: 'button', id: id });
      });
    }
    wireBlocks($('cards'));
  }

  function renderActions() {
    $('actions').innerHTML = view.buttons
      .map(
        (button) =>
          '<button class="' + (button.primary ? 'primary' : '') + '" data-id="' + escapeHtml(button.id) + '">' +
          escapeHtml(button.label) + '</button>',
      )
      .join('');
    for (const button of $('actions').querySelectorAll('button[data-id]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'button', id: button.getAttribute('data-id') });
      });
    }
  }

  function renderCountdown() {
    const el = $('countdown');
    if (expiresAt === null || expiresAt === undefined) { el.hidden = true; return; }
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    el.hidden = false;
    const mmss = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    el.textContent = left > 0 ? 'This sign-in expires in ' + mmss + '.' : 'This sign-in has expired.';
  }

  function render() {
    if (!view) return;
    $('title').textContent = view.title;
    $('region').textContent = view.regionLabel;

    const back = view.back;
    $('back').hidden = !back;
    if (back) {
      $('back').innerHTML = BACK_ICON;
      $('back').setAttribute('aria-label', back.label);
      $('back').setAttribute('title', back.tooltip);
    }

    $('tokenOnly').hidden = !view.tokenOnlyNotice;
    $('tokenOnly').textContent = view.tokenOnlyNotice || '';

    $('message').hidden = !view.message;
    $('message').textContent = view.message || '';

    $('detail').hidden = !view.detail;
    $('detail').textContent = view.detail || '';

    const field = view.apiBaseField;
    $('apiBaseRow').hidden = !field;
    if (field) {
      $('apiBaseLabel').textContent = field.label;
      if ($('apiBaseInput').value !== field.value) $('apiBaseInput').value = field.value;
      $('apiBaseError').hidden = !field.error;
      $('apiBaseError').textContent = field.error || '';
    }

    const who = view.identity;
    $('identity').hidden = !who;
    if (who) {
      $('identityInitials').textContent = who.initials;
      $('identityName').textContent = who.displayName;
      $('identitySub').textContent = who.email + ' · ' + who.regionLabel;
      $('identitySwitch').textContent = who.switchLabel;
    }

    const waiting = view.waiting;
    $('waiting').hidden = !waiting;
    expiresAt = waiting ? waiting.expiresAt : null;
    if (waiting) {
      $('waitingHeadline').textContent = waiting.headline;
      $('spinner').hidden = !waiting.showSpinner;
      $('waitingLeadIn').textContent = waiting.fallbackLeadIn;
      $('waitingSlot').innerHTML = linkHtml(waiting.link) + pasteHtml(waiting.paste);
      wireBlocks($('waitingSlot'));
    }
    renderCountdown();

    // The chooser exists on the LANDING only. The waiting state replaces it
    // outright, which is the fix for the PO's "the entire initial page shifts
    // down" -- there is no longer a page above the waiting state to shift.
    $('methods').hidden = view.cards.length === 0;
    if (view.cards.length > 0) renderCards();
    renderActions();
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'view') return;
    // A fresh landing means a fresh box; anything else keeps what was typed.
    if (event.data.payload && event.data.payload.stage === 'landing' && (!view || view.stage !== 'landing')) {
      pasteDraft = '';
    }
    view = event.data.payload;
    render();
  });

  $('apiBaseInput').addEventListener('change', () => {
    vscode.postMessage({ type: 'setApiBase', value: $('apiBaseInput').value });
  });
  $('back').addEventListener('click', () => { vscode.postMessage({ type: 'back' }); });
  $('identitySwitch').addEventListener('click', () => {
    vscode.postMessage({ type: 'button', id: 'use-different' });
  });

  setInterval(renderCountdown, 1000);
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
