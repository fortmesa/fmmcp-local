// Wiring tests for VSIX ROUND 6: the hosted paste callback going live
// (SIGNIN-5c) and the FortMesa first-land page (PO 2026-09-09,
// RESULT-VSIX-ROUND4 §3 option (ii)).
//
// These drive the real `startSignIn` session through the `vscode` stub and
// assert on what the extension ACTUALLY DID — which URL it handed
// `env.openExternal`, and which one it put on the clipboard — rather than on
// the shape of a helper. The two must differ on prod, and that difference is
// the whole feature: the browser lands on FortMesa, the copyable link stays
// the real Auth0 authorize URL.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/vsix-round6-wiring.test.mjs`.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./vscode-stub-signin-loader.mjs', import.meta.url);

const { startSignIn } = await import('../../dist/extension/sign-in-session.js');
const { ENVIRONMENTS } = await import('../../dist/registry/environments.js');

const log = { info() {}, warn() {}, error() {} };

async function startStubApi() {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${String(server.address().port)}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function nextEvent(session, predicate) {
  return new Promise((resolve) => {
    let handle;
    handle = session.onEvent((event) => {
      if (predicate(event)) {
        handle?.dispose();
        resolve(event);
      }
    });
  });
}

/** Run one paste-method sign-in far enough to observe the `waiting` event and what was opened. */
async function observeStart(env) {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-round6-'));
  const api = await startStubApi();
  const previous = { ...process.env };
  process.env.FMCODE_DIR = dir;
  globalThis.__fmmcpVscodeStub.calls.openExternal.length = 0;
  globalThis.__fmmcpVscodeStub.calls.clipboard.length = 0;
  try {
    const session = startSignIn(env, { mode: 'fresh' }, 'paste', log, { apiBase: api.base, timeoutMs: 2000 });
    const waiting = await nextEvent(session, (e) => e.type === 'waiting' || e.type === 'error');
    assert.equal(waiting.type, 'waiting', `sign-in for ${env} did not reach the waiting state: ${waiting.message}`);
    await session.copyLink();
    const opened = [...globalThis.__fmmcpVscodeStub.calls.openExternal];
    const copied = [...globalThis.__fmmcpVscodeStub.calls.clipboard];
    session.cancel();
    return { waiting, opened, copied };
  } finally {
    for (const [key, value] of Object.entries({ FMCODE_DIR: previous.FMCODE_DIR })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('prod: the browser is opened to the FortMesa start page, NOT to Auth0', async () => {
  const { waiting, opened } = await observeStart('prod');
  assert.equal(opened.length, 1);
  const startUrl = new URL(opened[0]);
  assert.equal(startUrl.origin, 'https://fortmesa.com');
  assert.equal(startUrl.pathname, '/a/auth/saferoom/start');
  // ...carrying exactly the request the extension would have sent to Auth0.
  const authorize = new URL(waiting.authorizeUrl);
  for (const key of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource']) {
    assert.equal(startUrl.searchParams.get(key), authorize.searchParams.get(key), `param ${key} must round-trip`);
  }
  // The authorize URL ITSELF is untouched: still Auth0, still /authorize.
  assert.equal(authorize.pathname, '/authorize');
  assert.notEqual(authorize.origin, 'https://fortmesa.com');
});

test('prod: "copy the link" still yields the REAL Auth0 authorize URL — pasting must not need the SPA session', async () => {
  const { waiting, copied, opened } = await observeStart('prod');
  assert.deepEqual(copied, [waiting.authorizeUrl]);
  assert.notEqual(copied[0], opened[0]);
  assert.ok(!copied[0].includes('/auth/saferoom/start'));
});

test('prod: the paste method now redirects to the HOSTED callback, and says so (SIGNIN-5c)', async () => {
  const { waiting } = await observeStart('prod');
  assert.equal(
    new URL(waiting.authorizeUrl).searchParams.get('redirect_uri'),
    'https://fortmesa.com/a/auth/saferoom/callback',
  );
  assert.equal(waiting.hostedPageLive, true);
  assert.equal(waiting.method, 'paste');
});

test('next: hosted callback live too, but the start page stays off until its FE routes it', async () => {
  const { waiting, opened } = await observeStart('next');
  assert.equal(
    new URL(waiting.authorizeUrl).searchParams.get('redirect_uri'),
    'https://next.fort.blue/a/auth/saferoom/callback',
  );
  assert.equal(waiting.hostedPageLive, true);
  // No first-land page: the browser goes straight to Auth0, exactly as before.
  assert.deepEqual(opened, [waiting.authorizeUrl]);
  assert.equal(ENVIRONMENTS.next.firstLandPage, undefined);
});

test('no credential or code is ever placed on the opened URL', async () => {
  for (const env of ['prod', 'next']) {
    const { opened } = await observeStart(env);
    const url = new URL(opened[0]);
    for (const forbidden of ['code', 'access_token', 'id_token', 'refresh_token']) {
      assert.equal(url.searchParams.has(forbidden), false, `${env}: ${forbidden} must not appear on the opened URL`);
    }
    assert.equal(url.hash, '');
  }
});
