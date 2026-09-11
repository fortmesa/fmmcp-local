// Unit tests for the pure sign-in method/intent decisions
// (src/registry/sign-in-method.ts — BRIEF-SIGNIN-1 step 9, PLAN §3.1).
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/sign-in-method.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chooseDefaultMethod, isLoopbackExternalUri, authorizeIntentParams } =
  await import('../../dist/registry/sign-in-method.js');

// ── The full pre-selection matrix ──────────────────────────────────────────
// forwardable × uiKindWeb × remembered(undefined|browser|paste) = 12 cases.
// Enumerated exhaustively rather than sampled: the whole point of this
// function is that no topology falls through to a method that cannot work.

const MATRIX = [
  // uiKindWeb wins over everything — a browser-hosted editor can never be
  // reached by a loopback redirect, remembered success or not.
  [{ forwardable: false, uiKindWeb: true, remembered: undefined }, 'paste', 'web'],
  [{ forwardable: true, uiKindWeb: true, remembered: undefined }, 'paste', 'web'],
  [{ forwardable: true, uiKindWeb: true, remembered: 'browser' }, 'paste', 'web'],
  [{ forwardable: false, uiKindWeb: true, remembered: 'paste' }, 'paste', 'web'],

  // Nothing remembered: the live signal decides.
  [{ forwardable: true, uiKindWeb: false, remembered: undefined }, 'browser', 'forwardable'],
  [{ forwardable: false, uiKindWeb: false, remembered: undefined }, 'paste', 'not-forwardable'],

  // A remembered method wins over the live signal — except that a remembered
  // `browser` is discarded when forwarding is no longer possible.
  [{ forwardable: true, uiKindWeb: false, remembered: 'browser' }, 'browser', 'remembered'],
  [{ forwardable: false, uiKindWeb: false, remembered: 'browser' }, 'paste', 'not-forwardable'],
  [{ forwardable: true, uiKindWeb: false, remembered: 'paste' }, 'paste', 'remembered'],
  [{ forwardable: false, uiKindWeb: false, remembered: 'paste' }, 'paste', 'remembered'],
];

for (const [topology, method, reason] of MATRIX) {
  test(`chooseDefaultMethod: ${JSON.stringify(topology)} -> ${method} (${reason})`, () => {
    assert.deepEqual(chooseDefaultMethod(topology), { method, reason });
  });
}

test('chooseDefaultMethod: a remembered value that is neither method is ignored, not trusted', () => {
  // `globalState` is user-writable JSON on disk; a garbage value must degrade
  // to the live signal rather than pick anything by accident.
  assert.deepEqual(chooseDefaultMethod({ forwardable: true, uiKindWeb: false, remembered: 'device-flow' }), {
    method: 'browser',
    reason: 'forwardable',
  });
});

// ── isLoopbackExternalUri ─────────────────────────────────────────────────

test('isLoopbackExternalUri: accepts the three loopback hosts a forwarded URI may use', () => {
  assert.equal(isLoopbackExternalUri('http://localhost:43117'), true);
  assert.equal(isLoopbackExternalUri('http://127.0.0.1:51234/'), true);
  assert.equal(isLoopbackExternalUri('http://[::1]:43117'), true);
});

test('isLoopbackExternalUri: refuses a PUBLIC tunnel host — the code must not travel through a third party', () => {
  assert.equal(isLoopbackExternalUri('https://abc123-43117.euw.devtunnels.ms/'), false);
  assert.equal(isLoopbackExternalUri('https://vscode.dev/tunnel/box/43117'), false);
});

test('isLoopbackExternalUri: refuses a non-http scheme and unparseable input', () => {
  assert.equal(isLoopbackExternalUri('vscode://fortmesa.saferoom/callback'), false);
  assert.equal(isLoopbackExternalUri('not a uri'), false);
  assert.equal(isLoopbackExternalUri(''), false);
});

// ── intent -> authorize params ────────────────────────────────────────────

test('authorizeIntentParams: continue sends login_hint and never prompt=login', () => {
  assert.deepEqual(authorizeIntentParams({ mode: 'continue', email: 'a@example.com' }), {
    loginHint: 'a@example.com',
  });
});

test('authorizeIntentParams: switch forces re-authentication', () => {
  // Without prompt=login an existing tenant SSO session hands back the very
  // identity the user is trying to leave.
  assert.deepEqual(authorizeIntentParams({ mode: 'switch' }), { prompt: 'login' });
});

test('authorizeIntentParams: a fresh sign-in sends neither', () => {
  assert.deepEqual(authorizeIntentParams({ mode: 'fresh' }), {});
});
