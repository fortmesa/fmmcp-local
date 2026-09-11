// Wiring + PO-constraint regressions for the sign-in PAGE
// (src/extension/sign-in-page.ts, src/extension/login-command.ts —
// BRIEF-SIGNIN-2 items 1, 3 and 4).
//
// The subject is source text, because the assertions are about what the
// extension may NOT contain (a native prompt on the sign-in path) and about
// webview hygiene that only exists in the emitted template string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(repoRoot, rel), 'utf-8');

// ── PO: no native prompt anywhere on the sign-in path ──────────────────────

test('PO: no showInputBox / showQuickPick / showWarningMessage-modal survives in src/extension', async () => {
  const dir = join(repoRoot, 'src', 'extension');
  const offenders = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue;
    const src = await readFile(join(dir, name), 'utf-8');
    // Comments explaining that these were REMOVED are fine; calls are not.
    for (const match of src.matchAll(/window\.(showInputBox|showQuickPick)\s*\(/g)) {
      offenders.push(`${name}: window.${match[1]}(`);
    }
  }
  assert.deepEqual(offenders, [], 'every sign-in question belongs on the sign-in page');
});

test('PO: the API base is a page field, and the page still refuses a cleartext one', async () => {
  const command = await read('src/extension/login-command.ts');
  // Calls, not prose: the file's doc comment says WHY the prompt was removed,
  // and that explanation is worth keeping.
  assert.equal(/vscode\.window\.showInputBox\(/.test(command), false, 'the unknown-env API base prompt must be gone');
  assert.equal(/resolveApiBase\s*\(/.test(command), false);
  const state = await read('src/registry/sign-in-page-state.ts');
  assert.match(state, /requireSecureApiBase\(/, 'F-6 must still be enforced, now on the page');
});

test('the sign-in commands do nothing but open the page', async () => {
  const command = await read('src/extension/login-command.ts');
  assert.match(command, /registerCommand\('fortmesa\.login', open\)/);
  assert.match(command, /registerCommand\('fortmesa\.openSignIn', open\)/);
  assert.match(command, /openSignInPage\(/);
  // The interim dead end SIGNIN-1 left for the paste method was a warning
  // toast; the command now has no toast-driven sign-in UX at all, only the
  // error path for a page that could not be opened.
  assert.equal(/showWarningMessage\(/.test(command), false);
  assert.equal(/startSignIn\(/.test(command), false, 'the command must not drive a session itself');
  assert.equal(/reportOutcome/.test(command), false);
});

test('the identity pane and the expired notice both route through fortmesa.login', async () => {
  const view = await read('src/extension/identity-view.ts');
  assert.match(view, /executeCommand\('fortmesa\.login'\)/);
  assert.match(view, /type: expired\.action === 'update-token' \? 'openTokenSettings' : 'signIn'/);
});

// ── Webview hygiene (security-delta F-1 / F-2, applied to the new panel) ────

test('the sign-in page is a single-instance, retained webview panel with the agreed view type', async () => {
  const src = await read('src/extension/sign-in-page.ts');
  assert.match(src, /createWebviewPanel\('fortmesa\.signIn'/);
  assert.match(src, /retainContextWhenHidden: true/);
  assert.match(src, /if \(activePanel !== undefined\) \{\s*activePanel\.reveal\(\);/);
});

test('F-2: the sign-in page builds its CSP nonce from a CSPRNG and forbids inline script', async () => {
  const src = await read('src/extension/sign-in-page.ts');
  assert.equal(/Math\.random/.test(src), false);
  assert.match(src, /randomBytes\(16\)\.toString\('base64'\)/);
  assert.match(src, /default-src 'none'/);
  assert.match(src, /script-src 'nonce-\$\{cspNonce\}'/);
  // `'unsafe-inline'` is permitted for STYLES only; the script directive must
  // rely on the nonce alone.
  const scriptDirective = src.slice(src.indexOf('`script-src'), src.indexOf('`script-src') + 60);
  assert.equal(scriptDirective.includes('unsafe-inline'), false);
});

test('F-1: every attribute interpolation in the sign-in page client script is escaped', async () => {
  const src = await read('src/extension/sign-in-page.ts');
  const pattern = /(?:\bid|\bfor|data-id|data-method)="'\s*\+\s*(?!escapeHtml\()([A-Za-z_$][\w$.]*)/g;
  for (const match of src.matchAll(pattern)) {
    assert.fail(`attribute value "${match[1]}" is interpolated without escapeHtml() — ${match[0]}`);
  }
  assert.match(src, /function escapeHtml/);
});

test('the authorize URL may cross the bridge; a code, a token and the PKCE verifier may NOT', async () => {
  // ROUND 3 changes this contract deliberately, on the PO's instruction. The
  // page shows the authorize URL in a READ-ONLY field so the user can see what
  // a copy would put on the clipboard and copy it by hand when the button
  // fails. That URL is an authorization REQUEST: client_id, state, the PKCE
  // challenge, the redirect URI. What must still never reach the webview is
  // anything that comes BACK from one.
  const state = await read('src/registry/sign-in-page-state.ts');
  assert.match(state, /readonly authorizeUrl: string \| undefined;/, 'the model carries the URL on purpose now');
  const page = await read('src/extension/sign-in-page.ts');
  for (const forbidden of ['access_token', 'refresh_token', 'code_verifier', 'codeVerifier', 'readToken']) {
    assert.equal(page.includes(forbidden), false, `the page must never handle ${forbidden}`);
    assert.equal(state.includes(forbidden), false, `the projector must never handle ${forbidden}`);
  }
  // Copying stays a HOST-side effect: a webview's own clipboard is not
  // dependable, and the read-only field is the manual fallback either way.
  assert.match(page, /runtime\.session\?\.copyLink\(\)/);
});

test('round 3: the controls the PO struck out are gone from the page, by name', async () => {
  const state = await read('src/registry/sign-in-page-state.ts');
  const page = await read('src/extension/sign-in-page.ts');
  // String literals, not prose: the comments explain WHY these went, and that
  // explanation is worth keeping.
  assert.equal(/'Open browser again'/.test(state + page), false);
  assert.equal(/reopenBrowser/.test(state + page), false);
  assert.equal(/label: 'Cancel'/.test(state), false);
  assert.equal(/'reopen'/.test(state + page), false);
  const session = await read('src/extension/sign-in-session.ts');
  assert.equal(/reopenBrowser/.test(session), false, 'the transport verb went with the button — no dead API');
});

test('the page defers disposing a session subscription, because onEvent replays synchronously', async () => {
  const src = await read('src/extension/sign-in-page.ts');
  assert.match(src, /queueMicrotask\(\(\) =>\s*\{\s*subscription\.dispose\(\);/);
  assert.match(src, /if \(token !== runtime\.sessionToken\) return;/);
});

test('closing the panel cancels a session still holding a loopback port', async () => {
  const src = await read('src/extension/sign-in-page.ts');
  const disposeBlock = src.slice(src.indexOf('panel.onDidDispose('));
  assert.match(disposeBlock, /runtime\.session\?\.cancel\(\)/);
});

// ── The client script actually runs ─────────────────────────────────────────
//
// A webview whose script throws renders a BLANK PAGE with no error anyone
// sees, so "it compiles" is not enough: the script is extracted from the real
// generated HTML and executed. This is the cheapest oracle that can observe a
// broken page at all without an extension host.

import { register } from 'node:module';
register('./vscode-stub-signin-loader.mjs', import.meta.url);

const { renderSignInPageHtml } = await import('../../dist/extension/sign-in-page.js');
const { initialSignInPageModel, projectSignInPage, reduceSignInPage } =
  await import('../../dist/registry/sign-in-page-state.js');

const html = renderSignInPageHtml({ cspSource: 'vscode-webview://test' }, 'test-nonce');

test('the generated page carries the CSP, the nonce and no stray script tag', () => {
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
});

test('the client script parses and runs, and renders every state without throwing', () => {
  const scriptBody = html.slice(
    html.indexOf('<script nonce="test-nonce">') + '<script nonce="test-nonce">'.length,
    html.lastIndexOf('</script>'),
  );

  // A DOM small enough to be honest about what it is: enough for the script's
  // element lookups, listeners and innerHTML writes, and nothing more.
  const nodes = new Map();
  /**
   * A child stub for one `[data-method]` / `[data-id]` element the script
   * writes via innerHTML and then wires up. It records its listeners so the
   * test can FIRE them — without this the keyboard handler is emitted into the
   * page and never executed, which is exactly the class of bug this test file
   * exists to catch.
   */
  const makeChild = (attributes) => {
    const handlers = new Map();
    return {
      attributes,
      handlers,
      focused: false,
      hidden: false,
      selected: false,
      value: '',
      innerHTML: '',
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute(name, value) {
        attributes[name] = value;
      },
      addEventListener: (name, handler) => handlers.set(name, handler),
      focus() {
        this.focused = true;
      },
      select() {
        this.selected = true;
      },
    };
  };
  /** Parse the attribute the script just wrote, in source order. */
  const parseChildren = (html, attribute) =>
    Array.from(html.matchAll(new RegExp(attribute + '="([^"]*)"', 'g')), (match) =>
      makeChild({ [attribute]: match[1] }),
    );

  const makeNode = (id) => ({
    id,
    hidden: false,
    textContent: '',
    className: '',
    value: '',
    disabled: false,
    innerHTML: '',
    children: [],
    byId: new Map(),
    handlers: new Map(),
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute: () => null,
    addEventListener(name, handler) {
      this.handlers.set(name, handler);
    },
    /** `#name` only — that is all the client script asks for inside a rendered block. */
    querySelector(selector) {
      const wanted = selector.replace('#', '');
      if (!new RegExp('id="' + wanted + '"').test(this.innerHTML)) return null;
      const key = wanted + '\u0000' + this.innerHTML;
      if (!this.byId.has(key)) this.byId.set(key, makeChild({ id: wanted }));
      return this.byId.get(key);
    },
    /**
     * Cached per (attribute, innerHTML): the client script calls this more
     * than once per render, and a fresh set of stubs each time would silently
     * discard the listeners it had just attached — which is precisely the bug
     * class this file exists to catch.
     */
    queryCache: new Map(),
    querySelectorAll(selector) {
      const attribute = selector.includes('data-method') ? 'data-method' : 'data-id';
      const key = attribute + '\u0000' + this.innerHTML;
      if (!this.queryCache.has(key)) this.queryCache.set(key, parseChildren(this.innerHTML, attribute));
      const found = this.queryCache.get(key);
      if (attribute === 'data-method') this.children = found;
      return found;
    },
  });
  const posted = [];
  const listeners = new Map();
  const context = {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    document: {
      getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, makeNode(id));
        return nodes.get(id);
      },
    },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    setInterval: () => 0,
    setTimeout: () => 0,
  };

  const run = Function('acquireVsCodeApi', 'document', 'window', 'setInterval', 'setTimeout', scriptBody);
  run(context.acquireVsCodeApi, context.document, context.window, context.setInterval, context.setTimeout);

  assert.deepEqual(posted, [{ type: 'ready' }], 'the page must announce itself so the host posts the first view');

  const onMessage = listeners.get('message');
  assert.ok(onMessage, 'the page must listen for view messages');

  const base = initialSignInPageModel('prod', {
    choice: { method: 'browser', reason: 'forwardable' },
    cachedIdentity: { email: 'dev-agent@fortmesa.com', displayName: 'Dev Agent' },
    hostedPageLive: false,
    oauthAvailable: true,
    apiBase: 'https://api.fortmesa.com',
  });
  const AUTHORIZE_URL = 'https://login.fortmesa.com/authorize?client_id=abc&state=deadbeef&code_challenge=xyz';
  const started = reduceSignInPage(base, { type: 'start', intent: { mode: 'fresh' } }).model;
  const waiting = reduceSignInPage(started, {
    type: 'session',
    event: {
      type: 'waiting',
      authorizeUrl: AUTHORIZE_URL,
      expiresAt: Date.now() + 60000,
      method: 'browser',
      hostedPageLive: false,
    },
  }).model;
  const codeCard = reduceSignInPage(reduceSignInPage(base, { type: 'select-method', method: 'paste' }).model, {
    type: 'session',
    event: {
      type: 'waiting',
      authorizeUrl: AUTHORIZE_URL,
      expiresAt: Date.now() + 60000,
      method: 'paste',
      hostedPageLive: false,
    },
  }).model;
  const signedIn = reduceSignInPage(waiting, {
    type: 'session',
    event: { type: 'success', identity: { email: 'a@b.com', displayName: 'A B', userId: 'u' }, expiry: new Date() },
  }).model;
  const ended = reduceSignInPage(waiting, { type: 'session', event: { type: 'cancelled' } }).model;

  for (const model of [base, codeCard, waiting, signedIn, ended]) {
    onMessage({ data: { type: 'view', payload: projectSignInPage(model) } });
  }
  assert.match(nodes.get('title').textContent, /Sign In to FortMesa Saferoom/);

  // ── Round 3: every action is inside its card; the waiting state replaces
  //    the chooser; the back arrow is the only chrome. ──────────────────────
  posted.length = 0;
  onMessage({ data: { type: 'view', payload: projectSignInPage(base) } });
  const cardsHtml = nodes.get('cards').innerHTML;
  assert.match(cardsHtml, /Code-based sign-in/);
  assert.match(cardsHtml, /Automatic browser flow/);
  assert.equal((cardsHtml.match(/role="radio"/g) ?? []).length, 2);
  assert.equal((cardsHtml.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.equal(/aria-disabled/.test(cardsHtml), false, 'nothing on this page is disabled');
  assert.equal(/Use this instead/.test(cardsHtml), false);
  assert.equal(/Chosen because/.test(cardsHtml), false);
  assert.equal((cardsHtml.match(/tabindex="0"/g) ?? []).length, 1);
  assert.equal((cardsHtml.match(/tabindex="-1"/g) ?? []).length, 1);
  // The browser card's own button, inside the card. Nothing in the bottom row.
  assert.match(cardsHtml, /data-id="continue"[^>]*>Continue as Dev Agent</);
  assert.equal(nodes.get('actions').innerHTML, '', 'the landing has no CTA row at all');
  assert.equal(nodes.get('identity').hidden, false, 'the identity row is above the chooser');
  assert.equal(nodes.get('identityInitials').textContent, 'DA');
  assert.equal(nodes.get('back').hidden, true, 'no back arrow on the landing');

  // The code card, selected and prepared: read-only URL, copy icon, paste box.
  onMessage({ data: { type: 'view', payload: projectSignInPage(codeCard) } });
  const codeHtml = nodes.get('cards').innerHTML;
  assert.match(codeHtml, /<input type="text" id="linkInput" readonly value="[^"]*authorize\?client_id=abc/);
  assert.match(codeHtml, /id="copyLink"[^>]*aria-label="Copy link"/);
  assert.match(codeHtml, /id="pasteInput"/);
  // The submit appears only when the box is non-empty; it starts hidden.
  assert.match(codeHtml, /id="pasteSubmit"[^>]* hidden>/);
  assert.equal(/data-id="continue"/.test(codeHtml), false, 'the browser card keeps nothing while unselected');

  // ── Fire the code card's own handlers ────────────────────────────────────
  const cardsNode = nodes.get('cards');
  const link = cardsNode.querySelector('#linkInput');
  link.handlers.get('focus')();
  assert.equal(link.selected, true, 'focusing the read-only URL must select it so Ctrl+C works');
  link.selected = false;
  link.handlers.get('click')({ stopPropagation() {} });
  assert.equal(link.selected, true, 'clicking it must select it too');

  posted.length = 0;
  const copy = cardsNode.querySelector('#copyLink');
  copy.handlers.get('click')({ stopPropagation() {} });
  assert.deepEqual(posted, [{ type: 'button', id: 'copy-link' }], 'copying is a host-side effect');
  assert.match(copy.innerHTML, /<path d="M3 8.5/, 'the icon flips to a check on copy');

  // Typing reveals the submit; Enter submits; an empty box submits nothing.
  posted.length = 0;
  const pasteInput = cardsNode.querySelector('#pasteInput');
  const pasteSubmit = cardsNode.querySelector('#pasteSubmit');
  pasteInput.handlers.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(posted, [], 'Enter on an empty box must do nothing');
  pasteInput.value = 'https://x/callback?code=a&state=b';
  pasteInput.handlers.get('input')();
  assert.equal(pasteSubmit.hidden, false, 'the Paste code button appears only once the box is non-empty');
  pasteInput.handlers.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(posted, [{ type: 'paste', text: 'https://x/callback?code=a&state=b' }]);
  posted.length = 0;
  pasteSubmit.handlers.get('click')({ stopPropagation() {} });
  assert.deepEqual(posted, [{ type: 'paste', text: 'https://x/callback?code=a&state=b' }]);

  // ── The waiting state ────────────────────────────────────────────────────
  onMessage({ data: { type: 'view', payload: projectSignInPage(waiting) } });
  assert.equal(nodes.get('methods').hidden, true, 'the waiting state REPLACES the chooser');
  assert.equal(nodes.get('identity').hidden, true, 'nothing above the waiting state can push it down');
  assert.equal(nodes.get('actions').innerHTML, '', 'no CTA row on the waiting state');
  assert.equal(nodes.get('back').hidden, false);
  assert.equal(nodes.get('back')['aria-label'], 'Back');
  assert.equal(nodes.get('back').title, 'Cancel and choose another way');
  assert.equal(nodes.get('spinner').hidden, false);
  assert.match(nodes.get('waitingLeadIn').textContent, /^If the browser shows a code or an address instead/);
  const slot = nodes.get('waitingSlot').innerHTML;
  assert.match(slot, /id="linkInput" readonly/);
  assert.match(slot, /id="copyLink"/);
  assert.match(slot, /id="pasteInput"/);
  assert.match(nodes.get('countdown').textContent, /This sign-in expires in \d+:\d\d\./);

  // ── Card selection is still the whole card, with the keyboard model intact ─
  posted.length = 0;
  onMessage({ data: { type: 'view', payload: projectSignInPage(base) } });
  const cards = nodes.get('cards').children;
  assert.equal(cards.length, 2, 'both cards must be wired, not just the selected one');
  assert.deepEqual(
    cards.map((c) => c.getAttribute('data-method')),
    ['browser', 'paste'],
  );
  cards[1].handlers.get('click')();
  assert.deepEqual(posted, [{ type: 'selectMethod', method: 'paste' }], 'the card itself must be the control');

  posted.length = 0;
  cards[0].handlers.get('keydown')({ key: 'ArrowDown' });
  assert.deepEqual(posted, [{ type: 'selectMethod', method: 'paste' }]);
  assert.equal(cards[1].focused, true, 'the arrow key must move focus, not only selection');

  posted.length = 0;
  cards[0].handlers.get('keydown')({ key: 'ArrowUp' });
  assert.deepEqual(posted, [{ type: 'selectMethod', method: 'paste' }], 'arrow navigation must wrap');

  posted.length = 0;
  cards[1].handlers.get('keydown')({ key: ' ' });
  assert.deepEqual(posted, [{ type: 'selectMethod', method: 'paste' }]);
  posted.length = 0;
  cards[1].handlers.get('keydown')({ key: 'a' });
  assert.deepEqual(posted, [], 'an unrelated key must not select anything');

  // The card's own button must NOT also re-select the card it sits in.
  posted.length = 0;
  let bubbled = false;
  nodes
    .get('cards')
    .querySelectorAll('button[data-id]')
    .find((b) => b.getAttribute('data-id') === 'continue')
    .handlers.get('click')({
    stopPropagation() {
      bubbled = true;
    },
  });
  assert.equal(bubbled, true, 'the card action must stop the click from reaching the radio');
  assert.deepEqual(posted, [{ type: 'button', id: 'continue' }]);

  // The back arrow and the identity switch, wired once at load.
  posted.length = 0;
  nodes.get('back').handlers.get('click')();
  assert.deepEqual(posted, [{ type: 'back' }]);
  posted.length = 0;
  nodes.get('identitySwitch').handlers.get('click')();
  assert.deepEqual(posted, [{ type: 'button', id: 'use-different' }]);
});
