// "Sign out" vs "Remove" (PO, 2026-09-08): clearing a PASTED access token
// from this editor does not revoke it, so calling that action "Sign out"
// over-promises. The kind is inferred — there is no stored field — and the
// inference is deliberately asymmetric: when the evidence is not positive we
// under-promise. These tests pin that asymmetry, because "make it symmetric"
// is the natural-looking simplification that would break it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialKind, clearCredentialAction } from '../../dist/registry/credential-kind.js';

test('a stored refresh token is the positive evidence of an interactive sign-in', () => {
  assert.equal(credentialKind({ hasRefreshToken: true, envHasOAuthSignIn: true }), 'sign-in');
});

test('no refresh token resolves to access-token — absence of evidence under-promises', () => {
  assert.equal(credentialKind({ hasRefreshToken: false, envHasOAuthSignIn: true }), 'access-token');
});

test('a token-only environment is always access-token, refresh token or not', () => {
  assert.equal(credentialKind({ hasRefreshToken: false, envHasOAuthSignIn: false }), 'access-token');
  assert.equal(
    credentialKind({ hasRefreshToken: true, envHasOAuthSignIn: false }),
    'access-token',
    'there was no sign-in to undo where no sign-in exists',
  );
});

test('the access-token action says Remove and says the token survives', () => {
  const action = clearCredentialAction('access-token', 'Production (NA-US)');
  assert.equal(action.label, 'Remove');
  assert.match(action.tooltip, /token itself stays valid/i);
  assert.doesNotMatch(action.tooltip, /revoke/i, 'nothing here revokes anything — do not imply it');
});

test('the sign-in action says Sign out, and names the region once', () => {
  const action = clearCredentialAction('sign-in', 'Production (NA-US)');
  assert.equal(action.label, 'Sign out');
  assert.match(action.tooltip, /Production \(NA-US\)/);
  assert.ok(action.tooltip.split(' ').length <= 12, 'tooltip stays a single short idea');
});
