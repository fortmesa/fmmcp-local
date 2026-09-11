// Unit tests for the Saferoom first-land page URL builder
// (src/registry/first-land.ts — RESULT-VSIX-ROUND4 §3 option (ii), PO
// 2026-09-09) and for the hosted-callback data turned on in
// src/registry/environments.ts (SIGNIN-5c).
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/first-land.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { firstLandUrl, browserOpenUrl, firstLandEnabled, FIRST_LAND_PARAMS } =
  await import('../../dist/registry/first-land.js');
const { ENVIRONMENTS } = await import('../../dist/registry/environments.js');
const { buildAuthorizeUrl } = await import('../../dist/registry/pkce.js');

/** A realistic authorize URL, built by the same function the extension uses. */
const authorizeFor = (extra = {}) =>
  buildAuthorizeUrl('https://auth.fortmesa.com', {
    clientId: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
    redirectUri: 'https://fortmesa.com/a/auth/saferoom/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    state: 'abc123',
    resource: 'https://api.fortmesa.com',
    scope: 'openid profile email offline_access',
    ...extra,
  });

test('prod: the browser is opened to the FortMesa start page, carrying the authorize parameters', () => {
  const url = new URL(firstLandUrl('prod', authorizeFor()));
  assert.equal(url.origin, 'https://fortmesa.com');
  assert.equal(url.pathname, '/a/auth/saferoom/start');
  assert.equal(url.searchParams.get('client_id'), 'https://fortmesa.com/oauth/saferoom-client-metadata.json');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fortmesa.com/a/auth/saferoom/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'abc123');
  assert.equal(url.searchParams.get('resource'), 'https://api.fortmesa.com');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
});

test('the start URL carries ONLY allowlisted keys — response_type is the FE’s to pin, not ours to forward', () => {
  const url = new URL(firstLandUrl('prod', authorizeFor()));
  for (const key of url.searchParams.keys()) {
    assert.ok(FIRST_LAND_PARAMS.includes(key), `unexpected key forwarded to the start page: ${key}`);
  }
  assert.equal(url.searchParams.has('response_type'), false);
});

test('prompt and login_hint ride along when the user picked "different account" / "continue as"', () => {
  const withPrompt = new URL(firstLandUrl('prod', authorizeFor({ prompt: 'login' })));
  assert.equal(withPrompt.searchParams.get('prompt'), 'login');
  const withHint = new URL(firstLandUrl('prod', authorizeFor({ loginHint: 'a b@example.com' })));
  // Round-trips through URLSearchParams on both sides, so the space survives.
  assert.equal(withHint.searchParams.get('login_hint'), 'a b@example.com');
});

test('NO credential ever reaches the start URL — it lands in history and in the referrer', () => {
  const url = new URL(firstLandUrl('prod', authorizeFor()));
  for (const forbidden of ['code', 'access_token', 'id_token', 'refresh_token', 'token']) {
    assert.equal(url.searchParams.has(forbidden), false, `${forbidden} must never appear on the start URL`);
  }
  assert.equal(url.hash, '');
  // And if a caller ever hands in a URL that already carries one, we refuse
  // the start page entirely rather than forwarding a stripped copy.
  const poisoned = `${authorizeFor()}&code=leaked`;
  assert.equal(firstLandUrl('prod', poisoned), undefined);
  assert.equal(browserOpenUrl('prod', poisoned), poisoned);
});

test('a malformed or incomplete authorize URL falls back to opening Auth0 directly', () => {
  assert.equal(firstLandUrl('prod', 'not a url'), undefined);
  const noState = 'https://auth.fortmesa.com/authorize?response_type=code&client_id=x&redirect_uri=y&code_challenge=z';
  assert.equal(firstLandUrl('prod', noState), undefined);
  assert.equal(browserOpenUrl('prod', noState), noState);
});

test('per-environment flag: prod only, until each FE deploys the auth/saferoom/start route', () => {
  assert.equal(firstLandEnabled('prod'), true);
  for (const name of ['next', 'latest', 'sandbox']) {
    assert.equal(firstLandEnabled(name), false, `${name}: start page must stay off until its FE routes it`);
    assert.equal(firstLandUrl(name, authorizeFor()), undefined);
  }
  assert.equal(firstLandEnabled('some-custom-env'), false);
});

test('browserOpenUrl is the ONLY behaviour change — the authorize URL itself is untouched', () => {
  const authorize = authorizeFor();
  assert.equal(browserOpenUrl('next', authorize), authorize);
  assert.notEqual(browserOpenUrl('prod', authorize), authorize);
  // The start URL is a different page, never a redirector holding the target.
  assert.equal(new URL(browserOpenUrl('prod', authorize)).searchParams.has('next'), false);
  assert.ok(!browserOpenUrl('prod', authorize).includes('auth.fortmesa.com'));
});

test('SIGNIN-5c: hostedCallback is set for every environment whose CIMD lists it, and only those', () => {
  assert.equal(ENVIRONMENTS.prod.hostedCallback, 'https://fortmesa.com/a/auth/saferoom/callback');
  assert.equal(ENVIRONMENTS.next.hostedCallback, 'https://next.fort.blue/a/auth/saferoom/callback');
  assert.equal(ENVIRONMENTS.latest.hostedCallback, 'https://latest.fort.blue/a/auth/saferoom/callback');
  // sandbox has no clientId and no OAuth login — a hosted callback there
  // would be an address Auth0 is never asked about.
  assert.equal(ENVIRONMENTS.sandbox.hostedCallback, undefined);
  assert.equal(ENVIRONMENTS.sandbox.clientId, undefined);
});

test('every hostedCallback lives on its OWN environment’s app host, never production’s', () => {
  for (const [name, entry] of Object.entries(ENVIRONMENTS)) {
    if (entry.hostedCallback === undefined) continue;
    assert.ok(
      entry.hostedCallback.startsWith(entry.app.replace(/\/+$/, '')),
      `${name}: hostedCallback must be on that environment's own app host`,
    );
    assert.ok(entry.hostedCallback.startsWith('https://'), `${name}: hostedCallback must be https`);
  }
});

test('regression — method A (loopback) is not broken by the start page: the forwarded callback rides through intact', () => {
  // The automatic flow's redirect_uri is a LOOPBACK or an asExternalUri-forwarded
  // address, not the hosted callback, and it is chosen after the port binds.
  // The start page must carry it through byte-for-byte: the FE forwards it to
  // Auth0 verbatim, Auth0 sends the browser back to it, and the extension's
  // own listener is what answers. Mangling it here would break method A on
  // production only — the environment with the least tolerance for that.
  for (const loopback of [
    'http://localhost:53219/callback',
    'http://127.0.0.1:53219/callback',
    'https://abc123-53219.remote.example.dev/callback',
  ]) {
    const url = new URL(
      firstLandUrl(
        'prod',
        buildAuthorizeUrl('https://auth.fortmesa.com', {
          clientId: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
          redirectUri: loopback,
          codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          state: 'abc123',
          resource: 'https://api.fortmesa.com',
        }),
      ),
    );
    assert.equal(url.searchParams.get('redirect_uri'), loopback);
  }
});
