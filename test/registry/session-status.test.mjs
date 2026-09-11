// Item 4 (PO, 2026-09-05): "The VSIX doesn't handle expired tokens well, when
// a token is expired it should prompt the user to refresh their session in the
// signed in user pane in some way".
//
// Two halves:
//  - the pure recovery routing (registry/session-status.ts), including the
//    token-only environment that has no sign-in to re-run at all;
//  - that the Signed-in user pane and the status bar actually consume it (the
//    defect was never in the expiry MATH — `formatRelativeExpiry` already
//    returned the word "expired" — it was that no surface acted on it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isSessionExpired, hasOAuthSignIn, expiredSessionNotice } from '../../dist/registry/session-status.js';

const at = (offsetMs) => new Date(Date.now() + offsetMs);

// ── isSessionExpired: only what can be PROVEN dead ────────────────────────

test('isSessionExpired: a past exp is expired', () => {
  assert.equal(isSessionExpired(at(-1000)), true);
});

test('isSessionExpired: exactly now counts as expired (the gate rejects it too)', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  assert.equal(isSessionExpired(now, now), true);
});

test('isSessionExpired: a future exp is not expired', () => {
  assert.equal(isSessionExpired(at(60_000)), false);
});

test('isSessionExpired: no exp (opaque token / no claim) is NOT expired — guessing would evict a working token', () => {
  assert.equal(isSessionExpired(undefined), false);
});

// ── recovery routing ──────────────────────────────────────────────────────

test('an OAuth environment is offered sign-in as the one-click default', () => {
  assert.equal(hasOAuthSignIn('prod'), true);
  const notice = expiredSessionNotice('prod');
  assert.equal(notice.action, 'sign-in');
  assert.equal(notice.message, 'Session expired — Sign in again');
  assert.match(notice.actionLabel, /Sign in again/);
  assert.match(notice.detail, /Production/, 'the detail must name the data region that expired');
});

test('a token-only environment is pointed at Settings > Advanced, NOT at a sign-in it does not have', () => {
  // sandbox has no clientId by design — see environments.ts.
  assert.equal(hasOAuthSignIn('sandbox'), false);
  const notice = expiredSessionNotice('sandbox');
  assert.equal(notice.action, 'update-token');
  assert.match(notice.actionLabel, /Settings/);
  assert.match(notice.detail, /token-only/);
  assert.match(notice.detail, /Advanced/);
});

test('every notice carries a status-bar tooltip and never leaks a token', () => {
  for (const env of ['prod', 'next', 'latest', 'sandbox']) {
    const notice = expiredSessionNotice(env);
    assert.ok(notice.statusBarTooltip.length > 0);
    assert.match(notice.statusBarTooltip, /FortMesa Saferoom/);
    assert.equal(/eyJ|Bearer /.test(JSON.stringify(notice)), false, 'no credential material in user-facing copy');
  }
});

test('an unknown environment still gets a usable notice (falls back to the token route, not a crash)', () => {
  const notice = expiredSessionNotice('some-custom-region');
  assert.equal(notice.action, 'update-token');
  assert.equal(notice.headline, 'Session expired');
});

// ── the surfaces actually consume it ──────────────────────────────────────

test('the Signed-in user pane renders the inline expired prompt with a one-click action, and no modal', async () => {
  const src = await readFile(new URL('../../dist/extension/identity-view.js', import.meta.url), 'utf-8');
  assert.match(src, /isSessionExpired/, 'buildState must consult the expiry gate');
  assert.match(src, /expiredSessionNotice/);
  assert.match(src, /id="expiredAction"/, 'the pane must offer the recovery button');
  assert.match(src, /id="expiredMessage"/);
  assert.match(src, /openTokenSettings/, 'the token-only route must reach Settings');
  assert.equal(/showWarningMessage|showInformationMessage|modal: true/.test(src), false, 'no modal (PO 2026-09-03)');
});

test('an expired credential flips signedIn off so the recovery replaces sign-out, not sits beside it', async () => {
  const src = await readFile(new URL('../../dist/extension/identity-view.js', import.meta.url), 'utf-8');
  assert.match(src, /signedIn: !expired/);
});

test('the status bar gains an expiry hint driven from the same notice', async () => {
  const bar = await readFile(new URL('../../dist/extension/status-bar.js', import.meta.url), 'utf-8');
  assert.match(bar, /setSessionExpired/);
  assert.match(bar, /statusBarItem\.warningBackground/);
  assert.match(bar, /\$\(warning\)/);

  const ext = await readFile(new URL('../../dist/extension/extension.js', import.meta.url), 'utf-8');
  assert.match(ext, /setSessionExpired/, 'activation must actually wire the hint');
  assert.match(ext, /readCredentialsSummary/, 'the expired fact comes from the stored credential');
});
