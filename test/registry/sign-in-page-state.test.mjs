// Unit tests for the sign-in page's state machine and its rendered view
// (src/registry/sign-in-page-state.ts — BRIEF-SIGNIN-2, PLAN §3.1).
//
// The page itself is a webview and cannot run in CI, so the PO's hard
// constraints are asserted HERE, against the projected view: both methods
// always visible, the paste field live during a browser flow, a bare code
// refused, no support-ticket copy.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/sign-in-page-state.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { initialSignInPageModel, reduceSignInPage, projectSignInPage, PASTE_NEEDS_BOTH_PARTS } =
  await import('../../dist/registry/sign-in-page-state.js');

const LANDING = {
  choice: { method: 'browser', reason: 'forwardable' },
  cachedIdentity: { email: 'dev-agent@fortmesa.com', displayName: 'Dev Agent' },
  hostedPageLive: false,
  oauthAvailable: true,
  apiBase: 'https://api.fortmesa.com',
};

const landing = (overrides = {}) => initialSignInPageModel('prod', { ...LANDING, ...overrides });

/** Apply a sequence of actions, returning the final model and the effects each step produced. */
function run(model, actions) {
  const effects = [];
  for (const action of actions) {
    const result = reduceSignInPage(model, action);
    model = result.model;
    effects.push(...result.effects);
  }
  return { model, effects };
}

const identity = (email, displayName = '') => ({ email, displayName, userId: 'u1' });

/** The card for a method, from a projected view. */
const cardFor = (view, method) => view.cards.find((c) => c.method === method);

const AUTHORIZE_URL =
  'https://login.fortmesa.com/authorize?client_id=abc&state=deadbeef&code_challenge=xyz&redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback';

/** The code-based card selected AND its session prepared — i.e. the authorize URL has landed. */
const preparedPaste = (overrides = {}) =>
  run(landing(overrides), [
    { type: 'select-method', method: 'paste' },
    {
      type: 'session',
      event: {
        type: 'waiting',
        authorizeUrl: AUTHORIZE_URL,
        expiresAt: 1000,
        method: 'paste',
        hostedPageLive: false,
      },
    },
  ]).model;

// ── S0 landing ─────────────────────────────────────────────────────────────

test('S0: the identity row names the account, the region and the way out of it', () => {
  const view = projectSignInPage(landing());
  assert.equal(view.stage, 'landing');
  assert.equal(view.title, 'Sign In to FortMesa Saferoom');
  assert.equal(view.identity.displayName, 'Dev Agent');
  assert.equal(view.identity.email, 'dev-agent@fortmesa.com');
  assert.equal(view.identity.regionLabel, view.regionLabel);
  assert.equal(view.identity.initials, 'DA');
  assert.equal(view.identity.switchLabel, 'Use a different account');
});

test('PO round 3: the landing has NO button row — every action is inside its card', () => {
  const view = projectSignInPage(landing());
  assert.deepEqual(view.buttons, [], 'the four-CTA row below the chooser is gone');
  assert.equal(cardFor(view, 'browser').action.id, 'continue');
  assert.equal(cardFor(view, 'browser').action.label, 'Continue as Dev Agent');
  assert.equal(cardFor(view, 'paste').action, undefined, 'the code card acts through its field and its box');
});

test('PO round 3: only the SELECTED card carries any action at all', () => {
  const browserSelected = projectSignInPage(landing());
  assert.equal(cardFor(browserSelected, 'paste').paste, undefined);
  assert.equal(cardFor(browserSelected, 'paste').link, undefined);
  const pasteSelected = projectSignInPage(preparedPaste());
  assert.equal(cardFor(pasteSelected, 'browser').action, undefined);
  assert.ok(cardFor(pasteSelected, 'paste').paste, 'the selected code card owns the paste box');
});

test('S0 without a cached identity: no identity row, and the card says Sign in', () => {
  const view = projectSignInPage(landing({ cachedIdentity: undefined }));
  assert.equal(view.identity, undefined);
  assert.equal(cardFor(view, 'browser').action.id, 'fresh');
  assert.equal(cardFor(view, 'browser').action.label, 'Sign in');
});

test('initials fall back to the email when the display name is empty', () => {
  const view = projectSignInPage(landing({ cachedIdentity: { email: 'ada@x.com', displayName: '' } }));
  assert.equal(view.identity.initials, 'AD');
});

test('S0: a token-only region replaces the sign-in controls with the Settings notice', () => {
  const view = projectSignInPage(landing({ oauthAvailable: false }));
  assert.ok(view.tokenOnlyNotice);
  assert.deepEqual(
    view.buttons.map((b) => b.id),
    ['open-token-settings'],
  );
});

test('S0: a token-only region cannot be started', () => {
  const { model, effects } = run(landing({ oauthAvailable: false }), [{ type: 'start', intent: { mode: 'fresh' } }]);
  assert.equal(model.stage, 'landing');
  assert.deepEqual(effects, []);
});

// ── PO constraint: BOTH methods, always ────────────────────────────────────

test('PO: both method cards are present in every state that shows the choice, in a fixed order', () => {
  for (const model of [landing(), landing({ choice: { method: 'paste', reason: 'not-forwardable' } })]) {
    const view = projectSignInPage(model);
    assert.deepEqual(
      view.cards.map((c) => c.method),
      ['browser', 'paste'],
      'the paste method must never be hidden, and the order must not depend on the selection',
    );
    assert.equal(view.cards.filter((c) => c.selected).length, 1);
  }
});

test('PO: a card is a title and ONE requirement — no blurb, no switch link, no justification', () => {
  for (const method of ['browser', 'paste']) {
    const view = projectSignInPage(landing({ choice: { method, reason: 'forwardable' } }));
    for (const card of view.cards) {
      assert.deepEqual(
        Object.keys(card).sort(),
        ['action', 'link', 'method', 'paste', 'requirement', 'selected', 'title'],
        'a card is its title, its requirement, its selection and ITS OWN actions — nothing else',
      );
      assert.ok(card.requirement.length > 0, 'both cards state their requirement, selected or not');
      if (!card.selected) {
        assert.deepEqual(
          [card.action, card.link, card.paste],
          [undefined, undefined, undefined],
          'an unselected card is two lines: selecting one may only grow THAT card',
        );
      }
    }
  }
});

test('PO: the two methods are named as the PO framed them, with one requirement each', () => {
  const view = projectSignInPage(landing());
  const browser = view.cards.find((c) => c.method === 'browser');
  const paste = view.cards.find((c) => c.method === 'paste');
  assert.equal(browser.title, 'Automatic browser flow');
  assert.equal(paste.title, 'Code-based sign-in');
  assert.equal(browser.requirement, 'Needs a local port this editor can listen on.');
  assert.equal(paste.requirement, 'You copy a code from the browser.');
});

test('PO: NO reason/justification copy survives anywhere, under any reason code or selection', () => {
  // The shipped bug: the reason line was a property of the PRE-SELECTION, not
  // of the selected card, so swapping to Paste rendered the BROWSER's
  // justification. Deleting the concept is what makes that unrepeatable, so
  // this asserts absence across every reason code AND after a swap.
  for (const reason of ['remembered', 'forwardable', 'not-forwardable', 'web']) {
    for (const method of ['browser', 'paste']) {
      const start = landing({ choice: { method, reason } });
      for (const model of [
        start,
        run(start, [{ type: 'select-method', method: method === 'browser' ? 'paste' : 'browser' }]).model,
      ]) {
        const text = JSON.stringify(projectSignInPage(model));
        assert.equal(/Chosen because/i.test(text), false, `reason "${reason}" leaked a justification`);
        assert.equal(/hand the sign-in straight back/i.test(text), false);
        assert.equal(/Use this instead/i.test(text), false);
        assert.equal(new RegExp(reason, 'i').test(text), false, 'a reason CODE must never reach copy');
      }
    }
  }
});

test('PO: no copy anywhere reads like a support ticket', () => {
  const models = [
    landing(),
    run(landing(), [{ type: 'start', intent: { mode: 'fresh' } }]).model,
    run(landing({ choice: { method: 'paste', reason: 'not-forwardable' } }), [
      { type: 'start', intent: { mode: 'fresh' } },
    ]).model,
    run(landing(), [
      { type: 'start', intent: { mode: 'fresh' } },
      { type: 'session', event: { type: 'error', message: 'the sign-in did not complete.' } },
    ]).model,
  ];
  for (const model of models) {
    const text = JSON.stringify(projectSignInPage(model));
    assert.equal(/having trouble/i.test(text), false, 'banned copy: "Having trouble?"');
    assert.equal(/didn't work\?/i.test(text), false);
    assert.equal(/contact support/i.test(text), false);
  }
});

test('selecting the code card PREPARES a session without opening any browser', () => {
  const { model, effects } = run(landing(), [{ type: 'select-method', method: 'paste' }]);
  assert.equal(model.method, 'paste');
  assert.equal(model.sessionActive, true);
  assert.deepEqual(effects, [
    {
      kind: 'start-sign-in',
      intent: { mode: 'continue', email: 'dev-agent@fortmesa.com' },
      method: 'paste',
      apiBase: 'https://api.fortmesa.com',
      openBrowser: false,
    },
  ]);
  assert.equal(
    effects.filter((e) => e.kind === 'start-sign-in')[0].openBrowser,
    false,
    'picking a card is not a request to launch a browser',
  );
});

test('the prepared session supplies the READ-ONLY link the user can copy by hand', () => {
  const card = cardFor(projectSignInPage(preparedPaste()), 'paste');
  assert.equal(card.link.value, AUTHORIZE_URL);
  assert.equal(card.link.copyLabel, 'Copy link');
  assert.equal(card.link.copiedLabel, 'Copied');
  // The URL is an authorization REQUEST: client_id, state, the PKCE challenge.
  // It must never be able to carry the things that come back from one.
  assert.equal(/[?&]code=/.test(card.link.value), false);
  assert.equal(/code_verifier|access_token|id_token/.test(card.link.value), false);
});

test('before the session has announced, the code card shows the box but no link yet', () => {
  const { model } = run(landing(), [{ type: 'select-method', method: 'paste' }]);
  const card = cardFor(projectSignInPage(model), 'paste');
  assert.equal(card.link, undefined);
  assert.ok(card.paste, 'the paste box is there from the moment the card is selected');
});

test('selecting the browser card again abandons the prepared code session', () => {
  const { model, effects } = run(preparedPaste(), [{ type: 'select-method', method: 'browser' }]);
  assert.equal(model.method, 'browser');
  assert.equal(model.sessionActive, false);
  assert.equal(model.authorizeUrl, undefined);
  assert.deepEqual(effects, [{ kind: 'abandon-session' }]);
});

test('the code card re-prepares against a NEW API base rather than showing a stale link', () => {
  const { model, effects } = run(landing({ apiBase: undefined }), [
    { type: 'select-method', method: 'paste' },
    { type: 'set-api-base', value: 'https://api.example.com' },
  ]);
  assert.equal(model.sessionActive, true);
  const starts = effects.filter((e) => e.kind === 'start-sign-in');
  assert.equal(starts.length, 1, 'nothing could be prepared until a base existed');
  assert.equal(starts[0].apiBase, 'https://api.example.com');
});

test('selecting the same card again is a no-op', () => {
  const { model, effects } = run(landing(), [{ type: 'select-method', method: 'browser' }]);
  assert.equal(model.stage, 'landing');
  assert.deepEqual(effects, []);
});

// ── The API-base field (replaces the removed input box) ────────────────────

test('S0: an environment with no known API base gets a field, not a prompt', () => {
  const view = projectSignInPage(landing({ apiBase: undefined }));
  assert.ok(view.apiBaseField, 'the unknown-env API base must be a field on the page');
  assert.equal(view.apiBaseField.value, '');
});

test('S0: starting with an empty API base asks for one and starts nothing', () => {
  const { model, effects } = run(landing({ apiBase: undefined }), [{ type: 'start', intent: { mode: 'fresh' } }]);
  assert.equal(model.stage, 'landing');
  assert.deepEqual(effects, []);
  assert.equal(projectSignInPage(model).apiBaseField.error, 'Enter an API base URL to sign in.');
});

test('S0: a cleartext API base is refused on the page, exactly as the input box refused it (F-6)', () => {
  const { model, effects } = run(landing({ apiBase: undefined }), [
    { type: 'set-api-base', value: 'http://api.example.com' },
    { type: 'start', intent: { mode: 'fresh' } },
  ]);
  assert.equal(model.stage, 'landing');
  assert.deepEqual(effects, []);
  assert.match(projectSignInPage(model).apiBaseField.error, /must use https:/);
});

test('S0: an https API base is accepted and carried into the session', () => {
  const { model, effects } = run(landing({ apiBase: undefined }), [
    { type: 'set-api-base', value: ' https://api.example.com ' },
    { type: 'start', intent: { mode: 'fresh' } },
  ]);
  assert.equal(model.stage, 'waiting');
  assert.deepEqual(effects, [
    {
      kind: 'start-sign-in',
      intent: { mode: 'fresh' },
      method: 'browser',
      apiBase: 'https://api.example.com',
      openBrowser: true,
    },
  ]);
});

// ── S1 waiting ─────────────────────────────────────────────────────────────

const waitingBrowser = () =>
  run(landing(), [
    { type: 'start', intent: { mode: 'continue', email: 'dev-agent@fortmesa.com' } },
    {
      type: 'session',
      event: {
        type: 'waiting',
        authorizeUrl: AUTHORIZE_URL,
        expiresAt: 1000,
        method: 'browser',
        hostedPageLive: false,
      },
    },
  ]).model;

test('S1(A): spinner, the self-updating headline, a countdown — and NO button row', () => {
  const view = projectSignInPage(waitingBrowser());
  assert.equal(view.waiting.showSpinner, true);
  assert.equal(view.waiting.headline, 'Your browser is open. Finish signing in there — this page updates on its own.');
  assert.equal(view.waiting.expiresAt, 1000);
  // The PO's headline complaint: four CTAs under a chooser that had also
  // stayed on screen. Both are gone.
  assert.deepEqual(view.buttons, [], 'the waiting state has no CTA row');
  assert.deepEqual(view.cards, [], 'the waiting state REPLACES the chooser rather than sitting under it');
  assert.equal(view.identity, undefined, 'nothing above the waiting state can push it down');
});

test('S1(A): the back arrow is the only chrome, and it says what it does', () => {
  const view = projectSignInPage(waitingBrowser());
  assert.equal(view.back.label, 'Back');
  assert.equal(view.back.tooltip, 'Cancel and choose another way');
  // The controls the PO struck out, by name.
  const everyLabel = JSON.stringify(view);
  assert.equal(/Open browser again/.test(everyLabel), false);
  assert.equal(/"label":"Cancel"/.test(everyLabel), false);
  assert.equal(/"label":"Copy link"/.test(everyLabel), false, 'Copy link is an icon beside the URL now');
});

test('S1(A): Back cancels the attempt and returns to the landing with the selection KEPT', () => {
  const { model, effects } = run(waitingBrowser(), [{ type: 'back' }]);
  assert.equal(model.stage, 'landing');
  assert.equal(model.method, 'browser', 'the previous selection survives going back');
  assert.equal(model.sessionActive, false);
  assert.deepEqual(effects, [{ kind: 'abandon-session' }]);
  const view = projectSignInPage(model);
  assert.equal(view.cards.length, 2, 'the chooser comes back');
  assert.equal(view.back, undefined);
});

test('Back never REWRITES the selection — it hands back whatever the model was on', () => {
  // The earlier version of this test started a code-based sign-in and pressed
  // back, which proves nothing: the code method never enters the waiting
  // stage, so `back` was inert and the assertion held vacuously. What actually
  // needs guarding is that `back` copies the method through rather than
  // resetting it, so it is asserted against a waiting model of each method.
  // A paste-flavoured wait is reachable: the transport's `waiting` event
  // carries the method, and the reducer adopts it.
  for (const method of ['browser', 'paste']) {
    const waiting = run(landing(), [
      { type: 'start', intent: { mode: 'fresh' } },
      {
        type: 'session',
        event: { type: 'waiting', authorizeUrl: AUTHORIZE_URL, expiresAt: 1000, method, hostedPageLive: false },
      },
    ]).model;
    assert.equal(waiting.method, method);
    assert.equal(run(waiting, [{ type: 'back' }]).model.method, method, 'back must not rewrite the selection');
  }
});

test('back is inert anywhere but the waiting state', () => {
  assert.deepEqual(run(landing(), [{ type: 'back' }]).effects, []);
});

test('S1(A): the waiting fallback carries the same read-only link and paste box as the card', () => {
  const view = projectSignInPage(waitingBrowser());
  assert.equal(view.waiting.link.value, AUTHORIZE_URL);
  assert.equal(view.waiting.link.copyLabel, 'Copy link');
  assert.equal(view.waiting.fallbackLeadIn, 'If the browser shows a code or an address instead, paste it here.');
  assert.equal(view.waiting.paste.prompt, 'Paste the code or address from the browser');
  assert.equal(view.waiting.paste.submitLabel, 'Paste code');
});

test('S1(A): a paste is accepted mid-browser-flow with no mode switch and no restart', () => {
  const model = waitingBrowser();
  const { model: after, effects } = run(model, [{ type: 'submit-paste', text: 'abc#xyz' }]);
  assert.equal(after.stage, 'waiting');
  assert.equal(after.method, 'browser', 'the rescue paste must not switch the method');
  assert.deepEqual(effects, [{ kind: 'submit-paste', text: 'abc#xyz' }]);
});

// S1(B) is gone as a STAGE: the code-based method never leaves the landing.
// Its former headline copy ("your browser will land on a page that won't
// load") described a browser we no longer open on its behalf — selecting the
// card prepares the URL and shows it; the user decides when to visit it.

test('the code-based method never enters the waiting stage — it stays on its card', () => {
  const { model } = run(preparedPaste(), [{ type: 'start', intent: { mode: 'fresh' } }]);
  assert.equal(model.stage, 'landing');
  assert.equal(projectSignInPage(model).waiting, undefined);
});

test('copy-link acts only while a session exists and a URL has landed', () => {
  assert.deepEqual(run(preparedPaste(), [{ type: 'copy-link' }]).effects, [{ kind: 'copy-link' }]);
  assert.deepEqual(run(waitingBrowser(), [{ type: 'copy-link' }]).effects, [{ kind: 'copy-link' }]);
  assert.deepEqual(run(landing(), [{ type: 'copy-link' }]).effects, [], 'nothing to copy before a session');
});

// ── Paste validation ───────────────────────────────────────────────────────

test('a bare code is refused inline and NEVER reaches the session', () => {
  const { model, effects } = run(waitingBrowser(), [{ type: 'submit-paste', text: 'onlyacode' }]);
  assert.deepEqual(
    effects,
    [],
    'a malformed paste must not be forwarded — the session treats a paste failure as terminal',
  );
  assert.equal(model.stage, 'waiting');
  assert.equal(model.pasteError, PASTE_NEEDS_BOTH_PARTS);
  assert.equal(model.pasteErrorFatal, false);
  assert.equal(projectSignInPage(model).waiting.paste.errorFatal, false);
});

test('a bare code is refused on the CODE card too, and the box stays live', () => {
  const { model, effects } = run(preparedPaste(), [{ type: 'submit-paste', text: 'onlyacode' }]);
  assert.deepEqual(effects, []);
  assert.equal(model.sessionActive, true, 'the prepared session survives a malformed paste');
  const paste = cardFor(projectSignInPage(model), 'paste').paste;
  assert.equal(paste.error, PASTE_NEEDS_BOTH_PARTS);
  assert.equal(paste.errorFatal, false);
});

test('a well-formed paste from the code card is forwarded and the control says so', () => {
  const { model, effects } = run(preparedPaste(), [{ type: 'submit-paste', text: 'abc#xyz' }]);
  assert.deepEqual(effects, [{ kind: 'submit-paste', text: 'abc#xyz' }]);
  assert.equal(cardFor(projectSignInPage(model), 'paste').paste.submitting, true);
  assert.equal(cardFor(projectSignInPage(model), 'paste').paste.submittingLabel, 'Signing in…');
});

test('an empty paste is refused inline', () => {
  const { model, effects } = run(waitingBrowser(), [{ type: 'submit-paste', text: '   ' }]);
  assert.deepEqual(effects, []);
  assert.ok(model.pasteError);
});

test('a full redirect URL and a code#state pair are both forwarded', () => {
  for (const text of ['http://127.0.0.1:43117/callback?code=abc&state=xyz', 'abc#xyz']) {
    const { effects } = run(waitingBrowser(), [{ type: 'submit-paste', text }]);
    assert.deepEqual(effects, [{ kind: 'submit-paste', text }]);
  }
});

test('after a refused paste the user can correct it and the corrected paste goes through', () => {
  const { model } = run(waitingBrowser(), [{ type: 'submit-paste', text: 'onlyacode' }]);
  const { model: after, effects } = run(model, [{ type: 'submit-paste', text: 'abc#xyz' }]);
  assert.deepEqual(effects, [{ kind: 'submit-paste', text: 'abc#xyz' }]);
  assert.equal(after.pasteError, undefined);
});

test('a state mismatch is stated in one sentence and offers Try again, not another paste', () => {
  const { model, effects } = run(waitingBrowser(), [
    {
      type: 'session',
      event: {
        type: 'error',
        message:
          'the authorization code you pasted came back with a different "state" than this sign-in sent. Start the sign-in again rather than reusing this code.',
      },
    },
  ]);
  assert.equal(model.stage, 'waiting');
  assert.equal(model.pasteError, 'That code is from a different sign-in. Start again.');
  assert.equal(model.pasteErrorFatal, true);
  assert.equal(model.sessionActive, false, 'a mismatched state ends the session; there is nothing left to paste into');
  assert.deepEqual(effects, [{ kind: 'release-session' }]);
  // The retry now lives WHERE THE ERROR IS — in the paste block that produced
  // it — rather than in a CTA row at the bottom of the page.
  const paste = projectSignInPage(model).waiting.paste;
  assert.equal(paste.errorFatal, true);
  assert.equal(paste.retryLabel, 'Try again');
  assert.deepEqual(projectSignInPage(model).buttons, []);
});

test('a state mismatch on the CODE card is stated on the card, and Try again is right there', () => {
  const { model } = run(preparedPaste(), [
    { type: 'session', event: { type: 'error', message: 'nope', kind: 'state-mismatch' } },
  ]);
  assert.equal(model.stage, 'landing');
  const card = cardFor(projectSignInPage(model), 'paste');
  assert.equal(card.paste.errorFatal, true);
  assert.equal(card.paste.error, 'That code is from a different sign-in. Start again.');
});

// ── S3 signed in ───────────────────────────────────────────────────────────

test('S3: names the account, the region and the exact expiry, and offers Done', () => {
  const expiry = new Date(Date.UTC(2026, 8, 8, 12, 0, 0));
  const { model, effects } = run(waitingBrowser(), [
    { type: 'session', event: { type: 'success', identity: identity('dev-agent@fortmesa.com', 'Dev Agent'), expiry } },
  ]);
  assert.equal(model.stage, 'signed-in');
  assert.deepEqual(effects, [{ kind: 'release-session' }]);
  const view = projectSignInPage(model);
  assert.match(view.message, /^Signed in as Dev Agent \(dev-agent@fortmesa\.com\)\. Your access to /);
  assert.match(view.message, / expires /);
  assert.equal(view.message.includes(expiry.toLocaleString()), true);
  assert.deepEqual(
    view.buttons.map((b) => b.id),
    ['done'],
  );
});

test('S3: Done closes the panel', () => {
  const { model } = run(waitingBrowser(), [
    { type: 'session', event: { type: 'success', identity: identity('a@b.com', 'A'), expiry: undefined } },
  ]);
  assert.deepEqual(run(model, [{ type: 'done' }]).effects, [{ kind: 'close-panel' }]);
});

test('S3: an identity the API did not return still reaches a signed-in state', () => {
  const { model } = run(waitingBrowser(), [
    { type: 'session', event: { type: 'success', identity: undefined, expiry: undefined } },
  ]);
  assert.equal(model.stage, 'signed-in');
  // No identity and no expiry: the page must NOT say "as this account" and
  // must NOT print the literal "unknown" where a date belongs.
  const message = projectSignInPage(model).message;
  assert.match(message, /^You're signed in — /);
  assert.equal(/unknown/i.test(message), false);
});

// ── S4 wrong account ───────────────────────────────────────────────────────

const wrongAccount = () =>
  run(waitingBrowser(), [
    {
      type: 'session',
      event: {
        type: 'wrong-account',
        intended: 'dev-agent@fortmesa.com',
        actual: 'other@fortmesa.com',
        identity: identity('other@fortmesa.com', 'Other Agent'),
        expiry: undefined,
      },
    },
  ]).model;

test('S4: states both accounts and offers Keep <actual> and Switch account', () => {
  const view = projectSignInPage(wrongAccount());
  assert.equal(view.message, 'You signed in as other@fortmesa.com, not dev-agent@fortmesa.com.');
  assert.deepEqual(
    view.buttons.map((b) => b.id),
    ['keep', 'switch'],
  );
  assert.deepEqual(
    view.buttons.map((b) => b.label),
    ['Continue as other@fortmesa.com', 'Sign in as dev-agent@fortmesa.com'],
  );
});

test('S4: Keep adopts the account we actually got, without a second sign-in', () => {
  const { model, effects } = run(wrongAccount(), [{ type: 'keep-account' }]);
  assert.equal(model.stage, 'signed-in');
  assert.equal(model.cachedIdentity.email, 'other@fortmesa.com');
  assert.deepEqual(effects, []);
});

test('S4: Switch account goes back to S0 with the switch intent, so Auth0 is forced to re-prompt', () => {
  const { model, effects } = run(wrongAccount(), [{ type: 'restart', intent: { mode: 'switch' } }]);
  assert.equal(model.stage, 'landing');
  assert.deepEqual(model.intent, { mode: 'switch' });
  assert.deepEqual(effects, [{ kind: 'release-session' }]);
  const { effects: started } = run(model, [{ type: 'start', intent: { mode: 'switch' } }]);
  assert.equal(started[0].intent.mode, 'switch');
});

// ── S5 cancelled / error ───────────────────────────────────────────────────

test('S5: cancelled and error both land on a single Try again', () => {
  for (const [event, expected] of [
    [{ type: 'cancelled' }, /Sign-in cancelled\./],
    [
      { type: 'error', message: 'the token endpoint said no.', kind: 'exchange-failed' },
      /^The sign-in didn't finish\.$/,
    ],
  ]) {
    const { model, effects } = run(waitingBrowser(), [{ type: 'session', event }]);
    assert.equal(model.stage, 'ended');
    assert.deepEqual(effects, [{ kind: 'release-session' }]);
    const view = projectSignInPage(model);
    assert.match(view.message, expected);
    // §3: exactly ONE next action. `Try again` returns to the landing, and
    // "Use a different account" is on the landing it returns to — offering it
    // here as well was the same control twice.
    assert.deepEqual(
      view.buttons.map((b) => b.id),
      ['try-again'],
    );
    assert.equal(view.back, undefined, 'Try again IS the way back; a second one would be noise');
    assert.deepEqual(view.cards, [], 'a terminal state replaces the chooser');
  }
});

test('S5: Try again returns to S0 keeping the intent; Use a different account switches it', () => {
  const ended = run(waitingBrowser(), [{ type: 'session', event: { type: 'cancelled' } }]).model;
  const again = run(ended, [{ type: 'restart' }]).model;
  assert.equal(again.stage, 'landing');
  assert.deepEqual(again.intent, { mode: 'continue', email: 'dev-agent@fortmesa.com' });
  assert.equal(again.endedMessage, undefined);
  const different = run(ended, [{ type: 'restart', intent: { mode: 'switch' } }]).model;
  assert.deepEqual(different.intent, { mode: 'switch' });
});

// ── Session-lifecycle hazards (SIGNIN-1's replay contract) ─────────────────

test('a replayed `waiting` from an abandoned session cannot drag the page back into S1', () => {
  const restarted = run(waitingBrowser(), [{ type: 'restart' }]).model;
  const { model } = run(restarted, [
    { type: 'session', event: { type: 'waiting', expiresAt: 9999, method: 'browser', hostedPageLive: false } },
  ]);
  assert.equal(model.stage, 'landing', 'a late replay must not re-enter the waiting state');
  assert.equal(model.expiresAt, undefined);
});

test('restarting mid-flight ABANDONS the session rather than cancelling it into view', () => {
  // `cancel()` emits `cancelled`, which would repaint the fresh landing state
  // as S5. The distinct effect is what stops that.
  const { effects } = run(waitingBrowser(), [{ type: 'restart' }]);
  assert.deepEqual(effects, [{ kind: 'abandon-session' }]);
});

test('swapping method mid-flight abandons the session and returns to S0', () => {
  const { model, effects } = run(waitingBrowser(), [{ type: 'select-method', method: 'paste' }]);
  assert.equal(model.stage, 'landing', 'the method decides the redirect_uri, so a swap cannot join a running flow');
  assert.equal(model.method, 'paste');
  assert.deepEqual(
    effects.map((e) => e.kind),
    ['abandon-session', 'start-sign-in'],
  );
  assert.equal(effects[1].openBrowser, false, 'the swap prepares the code URL; it does not launch anything');
});

test('a paste submitted when nothing is running is ignored', () => {
  assert.deepEqual(run(landing(), [{ type: 'submit-paste', text: 'abc#xyz' }]).effects, []);
});

// ── S5 error copy by KIND (SIGNIN-9) ───────────────────────────────────────
//
// The shipped page rendered `errorMessage(error)` verbatim, so the two-minute
// timeout — the likeliest failure there is — read "Sign-in did not finish:
// timed out after 120000ms waiting for the OAuth callback." Each kind now maps
// to copy, and only the two kinds with nothing better to say carry the raw
// message at all, as a muted detail line.

test('S5: every failure kind gets plain copy, and no raw exception text leaks', () => {
  const raw = 'timed out after 120000ms waiting for the OAuth callback.';
  const cases = [
    ['timeout', 'The sign-in timed out — nothing came back from your browser.', undefined],
    ['not-configured', "Saferoom doesn't have sign-in settings for Production (NA-US) yet.", undefined],
    ['bad-paste', "That code couldn't be read. Copy the whole thing and try again.", undefined],
    ['provider-refused', 'Your identity provider turned the sign-in down.', raw],
    ['exchange-failed', "The sign-in didn't finish.", raw],
    ['unknown', "The sign-in didn't finish.", raw],
  ];
  for (const [kind, message, detail] of cases) {
    const { model } = run(waitingBrowser(), [{ type: 'session', event: { type: 'error', message: raw, kind } }]);
    assert.equal(model.stage, 'ended');
    assert.equal(model.endedFailure, kind);
    const view = projectSignInPage(model);
    assert.equal(view.message, message, `kind "${kind}"`);
    assert.equal(view.detail, detail, `kind "${kind}" detail`);
    if (detail === undefined) {
      assert.equal(view.message.includes('120000ms'), false, `kind "${kind}" leaked the raw message`);
    }
  }
});

test('S5: the no-api-base failure names the environment and the one place to fix it', () => {
  const { model } = run(waitingBrowser(), [
    { type: 'session', event: { type: 'error', message: 'internal prose', kind: 'no-api-base' } },
  ]);
  assert.equal(
    projectSignInPage(model).message,
    "Saferoom doesn't know the API address for \u201Cprod\u201D. Add one in Settings \u203A Advanced.",
  );
  assert.equal(projectSignInPage(model).detail, undefined);
});

test('S5: a `state-mismatch` KIND is inline on the waiting state, exactly as the message sniff was', () => {
  const { model } = run(waitingBrowser(), [
    { type: 'session', event: { type: 'error', message: 'anything at all', kind: 'state-mismatch' } },
  ]);
  assert.equal(model.stage, 'waiting');
  assert.equal(model.pasteError, 'That code is from a different sign-in. Start again.');
  assert.equal(model.pasteErrorFatal, true);
});

test('S5: an error with NO kind still behaves exactly as it did before (additive contract)', () => {
  const mismatch = run(waitingBrowser(), [
    {
      type: 'session',
      event: { type: 'error', message: 'came back with a different "state" than this sign-in sent.' },
    },
  ]).model;
  assert.equal(mismatch.stage, 'waiting', 'the message sniff must survive as the no-kind fallback');
  const other = run(waitingBrowser(), [{ type: 'session', event: { type: 'error', message: 'boom' } }]).model;
  assert.equal(other.stage, 'ended');
  assert.equal(other.endedFailure, 'unknown');
  assert.equal(projectSignInPage(other).detail, 'boom');
});

test('S5: a cancelled sign-in carries no failure kind and no detail line', () => {
  const { model } = run(waitingBrowser(), [{ type: 'session', event: { type: 'cancelled' } }]);
  assert.equal(model.endedFailure, undefined);
  assert.equal(projectSignInPage(model).detail, undefined);
});

// ── Paste-validation copy must not echo the paste back into the DOM ────────

test('a paste error NEVER echoes the pasted text (it carries a live authorization code)', async () => {
  const { parsePastedCode } = await import('../../dist/registry/oauth-flow.js');
  const secret = 'https://app.example.com/cb?state=st4te&secret_code_value=SHOULDNOTAPPEAR';
  for (const text of [secret, 'http://[not a url', '', '   ', 'nohashhere']) {
    let model;
    try {
      parsePastedCode(text);
      continue; // parsed fine — nothing to assert
    } catch {
      model = run(waitingBrowser(), [{ type: 'submit-paste', text }]).model;
    }
    assert.ok(model.pasteError, `"${text}" must produce an error`);
    assert.equal(model.pasteError.includes('SHOULDNOTAPPEAR'), false, 'the paste must not be echoed');
    assert.equal(model.pasteError.includes(text.trim()) && text.trim() !== '', false);
    assert.equal(/query parameter/i.test(model.pasteError), false, 'no OAuth vocabulary in user-facing copy');
  }
});

test('an empty paste asks for the paste in plain words', () => {
  const { model } = run(waitingBrowser(), [{ type: 'submit-paste', text: '   ' }]);
  assert.equal(model.pasteError, 'Paste the code or address from your browser first.');
});

// ── The identity landing (PO: "continue with this user, or switch") ────────

const { authorizeIntentParams } = await import('../../dist/registry/sign-in-method.js');

test('identity landing: Continue-as starts the SELECTED method with a login hint, not a re-prompt', () => {
  const { effects } = run(landing(), [
    { type: 'start', intent: { mode: 'continue', email: 'dev-agent@fortmesa.com' } },
  ]);
  const start = effects.find((e) => e.kind === 'start-sign-in');
  assert.equal(start.method, 'browser');
  assert.deepEqual(authorizeIntentParams(start.intent), { loginHint: 'dev-agent@fortmesa.com' });
});

test('identity landing: Use a different account forces Auth0 to show the login form (prompt=login)', () => {
  for (const method of ['browser', 'paste']) {
    const from = method === 'paste' ? preparedPaste() : landing();
    const { effects } = run(from, [{ type: 'start', intent: { mode: 'switch' } }]);
    const start = effects.filter((e) => e.kind === 'start-sign-in').at(-1);
    assert.equal(start.method, method, 'it switches the ACCOUNT, never the method');
    assert.deepEqual(authorizeIntentParams(start.intent), { prompt: 'login' });
    assert.equal(
      start.openBrowser,
      method === 'browser',
      'on the code card a switch re-prepares the link; it does not open anything',
    );
  }
});

test('identity landing: with no cached identity there is no identity row and nothing to switch from', () => {
  const view = projectSignInPage(landing({ cachedIdentity: undefined }));
  assert.equal(view.identity, undefined);
  assert.equal(JSON.stringify(view).includes('Use a different account'), false);
});

test('a successful sign-in becomes the identity the NEXT landing offers', () => {
  const { model } = run(waitingBrowser(), [
    {
      type: 'session',
      event: { type: 'success', identity: identity('new@fortmesa.com', 'New Person'), expiry: undefined },
    },
  ]);
  assert.deepEqual(model.cachedIdentity, { email: 'new@fortmesa.com', displayName: 'New Person' });
});

// ── The layout invariant the PO reported as "the entire page shifts down" ──

test('PO: selecting a card may only grow THAT card — never anything above the chooser', () => {
  const before = projectSignInPage(landing());
  const after = projectSignInPage(preparedPaste());
  const above = (view) =>
    JSON.stringify([
      view.title,
      view.regionLabel,
      view.identity,
      view.apiBaseField,
      view.message,
      view.detail,
      view.tokenOnlyNotice,
      view.back,
      view.buttons,
    ]);
  assert.equal(above(after), above(before), 'everything above the cards must be byte-identical across a selection');
  assert.equal(after.cards.length, before.cards.length);
});
