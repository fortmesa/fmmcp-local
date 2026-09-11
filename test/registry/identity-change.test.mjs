// The scope panel's notice when the identity changes underneath it
// (PO, 2026-09-08: "When auth state changes (new session selected …) scope
// selector is no longer valid but state is not refreshed").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityChangeNotice } from '../../dist/registry/identity-change.js';

test('a completed sign-in names the new identity', () => {
  assert.equal(identityChangeNotice('signed-in', 'Ada Lovelace'), 'Signed in as Ada Lovelace — scopes reloaded');
});

test('with no label the line still has to be TRUE, so it names the event instead of the person', () => {
  // A pasted access token: nothing has fetched an identity, and "no additional
  // calls" rules out fetching one just to decorate a notice.
  for (const missing of [undefined, '', '   ']) {
    assert.equal(identityChangeNotice('signed-in', missing), 'Identity changed — scopes reloaded');
  }
});

test('signing out says the scopes are gone, not that someone new arrived', () => {
  assert.equal(identityChangeNotice('signed-out'), 'Signed out — scopes are no longer available.');
  assert.equal(
    identityChangeNotice('signed-out', 'Ada Lovelace'),
    'Signed out — scopes are no longer available.',
    'a stale label must never survive a sign-out',
  );
});
