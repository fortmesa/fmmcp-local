// Unit tests for src/registry/oauth-provider.ts -- specifically WHICH audience
// (RFC 8707 `resource`) a sign-in asks Auth0 for.
//
// The bug these pin (PO report 2026-09-08): "Continue as <name>" against
// production landed on Auth0's "Oops!, something went wrong" page. The
// authorize URL carried the correct prod `client_id` but
// `resource=https://api.vciso.app` -- a vanity brand alias of the production
// API (same IPs as api.fortmesa.com) that is NOT a registered Auth0 resource
// server. Auth0 answered 403 with
//   access_denied : Service not found: https://api.vciso.app
// The vanity host came from the user's stored `fortmesa_api_base`, because the
// provider derived `resource` from the caller-supplied API base while taking
// `client_id` from the environment registry. A known environment's audience is
// registry data, not user data.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/oauth-provider.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOAuthProvider, OAUTH_SCOPE } from '../../dist/registry/oauth-provider.js';
import { ENVIRONMENTS } from '../../dist/registry/environments.js';

test('a known environment ignores a vanity stored API base and asks for its canonical audience', () => {
  const provider = resolveOAuthProvider('prod', 'https://api.vciso.app');
  assert.equal(provider.resource, 'https://api.fortmesa.com');
  assert.equal(provider.clientId, 'https://fortmesa.com/oauth/saferoom-client-metadata.json');
});

test('every registry environment with a sign-in resolves to its own registry audience', () => {
  for (const [env, entry] of Object.entries(ENVIRONMENTS)) {
    if (entry.clientId === undefined) continue;
    // Pass a deliberately WRONG apiBase: the registry must win for a known env.
    const provider = resolveOAuthProvider(env, 'https://api.vciso.app');
    assert.equal(provider.resource, new URL(entry.api).origin, `${env} audience`);
    assert.equal(provider.clientId, entry.clientId, `${env} client_id`);
    assert.equal(provider.scope, OAUTH_SCOPE, `${env} scope`);
  }
});

test('an environment the registry does not know has no sign-in at all — it does not borrow an audience', () => {
  // Unchanged by the 2026-09-08 fix and deliberately so: without a CIMD
  // identity there is no OAuth login, so there is nothing to point an audience
  // at. This is the same refusal a token-only environment gets.
  assert.throws(() => resolveOAuthProvider('some-self-hosted', 'https://api.example.com'), /token-only/);
});

test('with an explicit client_id override, an unknown environment falls back to the supplied API base ORIGIN', () => {
  const previous = process.env.FMCODE_OAUTH_CLIENT_ID;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.test/client-metadata.json';
  try {
    // Origin only: no path, no trailing slash — Auth0 identifiers are bare origins.
    assert.equal(
      resolveOAuthProvider('some-self-hosted', 'https://api.example.com/v2/').resource,
      'https://api.example.com',
    );
    assert.throws(() => resolveOAuthProvider('some-self-hosted', 'not a url'), /resource indicator/);
  } finally {
    if (previous === undefined) delete process.env.FMCODE_OAUTH_CLIENT_ID;
    else process.env.FMCODE_OAUTH_CLIENT_ID = previous;
  }
});

test('a client_id override never redirects a KNOWN environment away from its registry audience', () => {
  const previous = process.env.FMCODE_OAUTH_CLIENT_ID;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.test/client-metadata.json';
  try {
    assert.equal(resolveOAuthProvider('prod', 'https://api.vciso.app').resource, 'https://api.fortmesa.com');
  } finally {
    if (previous === undefined) delete process.env.FMCODE_OAUTH_CLIENT_ID;
    else process.env.FMCODE_OAUTH_CLIENT_ID = previous;
  }
});

test('a token-only environment (no CIMD identity) refuses rather than borrowing another audience', () => {
  const sandbox = ENVIRONMENTS.sandbox;
  if (sandbox === undefined) return; // prod-only build ships no sandbox
  assert.throws(() => resolveOAuthProvider('sandbox', sandbox.api), /token-only/);
});
