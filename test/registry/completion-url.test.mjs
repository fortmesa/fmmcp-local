// Unit tests for `completionUrl` (src/registry/environments.ts — the 302
// target the sign-in sends the browser to once the outcome is known:
// BRIEF-SIGNIN-1 step 3 / step 9, PLAN §3.2).
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/completion-url.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { completionUrl, appLaunchUrl, ENVIRONMENTS } = await import('../../dist/registry/environments.js');

test('completionUrl: composes the /a/ app channel, the route, and exactly two params', () => {
  // The `/a/` is the whole reason this is derived from appLaunchUrl: the app
  // root is the MARKETING site, so `<app>/auth/...` would 404 into HubSpot.
  assert.equal(completionUrl('prod', 'ok'), 'https://fortmesa.com/a/auth/saferoom/complete?outcome=ok&env=prod');
  assert.equal(
    completionUrl('next', 'cancelled'),
    'https://next.fort.blue/a/auth/saferoom/complete?outcome=cancelled&env=next',
  );
  assert.equal(
    completionUrl('latest', 'error'),
    'https://latest.fort.blue/a/auth/saferoom/complete?outcome=error&env=latest',
  );
});

test('completionUrl: is built on the environment’s OWN app host, never production’s', () => {
  for (const name of Object.keys(ENVIRONMENTS)) {
    assert.ok(
      completionUrl(name, 'ok').startsWith(appLaunchUrl(name)),
      `${name}: completion URL must live under that environment's own /a/ root`,
    );
  }
});

test('completionUrl: an unknown environment falls back to the production app but keeps its own env name', () => {
  // Same fallback as appLaunchUrl/accessTokenUrl — the only host we can
  // honestly claim exists — while `env` stays truthful so the page can say
  // something accurate.
  const url = new URL(completionUrl('my-custom-env', 'ok'));
  assert.equal(url.origin, 'https://fortmesa.com');
  assert.equal(url.pathname, '/a/auth/saferoom/complete');
  assert.equal(url.searchParams.get('env'), 'my-custom-env');
});

test('completionUrl: carries NOTHING but outcome and env — no code, token, or identity', () => {
  const url = new URL(completionUrl('prod', 'ok'));
  assert.deepEqual([...url.searchParams.keys()].sort(), ['env', 'outcome']);
  assert.equal(url.hash, '');
});

test('completionUrl: percent-encodes a hostile environment name instead of concatenating it', () => {
  const url = new URL(completionUrl('a b&outcome=ok', 'error'));
  assert.equal(url.searchParams.get('outcome'), 'error');
  assert.equal(url.searchParams.get('env'), 'a b&outcome=ok');
});

test('a hostedCallback is set only where the environment’s CIMD actually lists it (SIGNIN-5c, 2026-09-09)', () => {
  // Was "no environment ships one yet". As of 2026-09-09 all three OAuth
  // environments' CIMD documents list `<app>/a/auth/saferoom/callback` and
  // Auth0's client records have been refreshed — verified by an anonymous
  // GET /authorize per environment (302 to the login page, with an unlisted
  // sibling path 403ing as the control). The rule the original test was
  // protecting is unchanged and is what is asserted now: an environment with
  // no OAuth login must never carry one, and one that does must point at its
  // own host over https (see test/registry/first-land.test.mjs).
  for (const [name, entry] of Object.entries(ENVIRONMENTS)) {
    if (entry.clientId === undefined) {
      assert.equal(entry.hostedCallback, undefined, `${name}: no OAuth login, so no hosted callback`);
      continue;
    }
    assert.equal(
      entry.hostedCallback,
      `${entry.app.replace(/\/+$/, '')}/a/auth/saferoom/callback`,
      `${name}: hosted callback must be this environment's own /a/ callback route`,
    );
  }
});
