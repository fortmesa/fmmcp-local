// End-to-end-ish tests for the sign-in SESSION
// (src/extension/sign-in-session.ts — BRIEF-SIGNIN-1 steps 7/8/9).
//
// These are not shape assertions: each one runs a real OAuth code exchange
// against a local fake authorization server, lets the session persist to a
// real credentials.json under a temp FMCODE_DIR, and then READS THE RESULT
// BACK THROUGH A DIFFERENT PATH (`readCurrentToken` / `readCachedIdentity`)
// than the one that wrote it.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/sign-in-session.test.mjs`.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./vscode-stub-signin-loader.mjs', import.meta.url);

const { startSignIn } = await import('../../dist/extension/sign-in-session.js');
const { readCurrentToken, readCachedIdentity } = await import('../../dist/registry/credentials.js');

/**
 * A fake Auth0 + FortMesa API on one port: `POST /oauth/token` mints a token,
 * `GET /api/v2/me` returns whoever the test says the token belongs to.
 * Records every token request so the test can assert what was actually sent.
 */
async function startFakeServer({ identityEmail, tokenStatus = 200 }) {
  const seen = { tokenRequests: [], meAuthHeaders: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
        if (tokenStatus !== 200) {
          res.writeHead(tokenStatus, { 'Content-Type': 'text/plain' });
          res.end('invalid_grant');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'access-token-value', expires_in: 3600, refresh_token: 'r1' }));
      });
      return;
    }
    if (url.pathname === '/api/v2/me') {
      seen.meAuthHeaders.push(req.headers.authorization !== undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: identityEmail, displayName: 'Test User', userId: 'u1' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const log = { info() {}, warn() {}, error() {} };

/** Wait for the first event of a given type, or the first terminal event. */
function nextEvent(session, predicate) {
  return new Promise((resolve) => {
    // `onEvent` REPLAYS the story so far to a late subscriber, synchronously,
    // before it returns — so the handle may not exist yet when the listener
    // first fires. Dispose defensively.
    let sub;
    let done = false;
    sub = session.onEvent((event) => {
      if (done || !predicate(event)) return;
      done = true;
      sub?.dispose();
      resolve(event);
    });
    if (done) sub.dispose();
  });
}

/** Run one paste-method sign-in against a fake server; returns the terminal event. */
async function runPasteSignIn({ identityEmail, intent, tokenStatus }) {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail, tokenStatus });
  const previous = {
    FMCODE_DIR: process.env.FMCODE_DIR,
    FMCODE_OAUTH_ISSUER: process.env.FMCODE_OAUTH_ISSUER,
    FMCODE_OAUTH_CLIENT_ID: process.env.FMCODE_OAUTH_CLIENT_ID,
  };
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';

  try {
    const remembered = [];
    const session = startSignIn('next', intent, 'paste', log, {
      apiBase: fake.base,
      memory: { get: () => undefined, remember: async (m) => void remembered.push(m) },
      timeoutMs: 5000,
    });

    const waiting = await nextEvent(session, (e) => e.type === 'waiting');
    const terminal = nextEvent(session, (e) => e.type !== 'waiting');
    const state = new URL(waiting.authorizeUrl).searchParams.get('state');
    session.submitPasted(`the-code#${state}`);
    return { waiting, terminal: await terminal, fake, dir, remembered, session };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fake.close();
    // `dir` is intentionally NOT removed here — assertions read it. Cleaned below.
  }
}

test('paste method: a matching identity is a success, and the token is readable back through credentials.json', async () => {
  const { terminal, fake, dir, remembered } = await runPasteSignIn({
    identityEmail: 'user@example.com',
    intent: { mode: 'continue', email: 'user@example.com' },
  });
  try {
    assert.equal(terminal.type, 'success');
    assert.equal(terminal.identity.email, 'user@example.com');

    // The exchange really happened, with the PKCE verifier and the SAME
    // redirect_uri the authorize URL used.
    assert.equal(fake.seen.tokenRequests.length, 1);
    assert.equal(fake.seen.tokenRequests[0].grant_type, 'authorization_code');
    assert.equal(fake.seen.tokenRequests[0].code, 'the-code');
    assert.ok(fake.seen.tokenRequests[0].code_verifier.length >= 43);
    assert.equal(fake.seen.tokenRequests[0].client_secret, undefined);

    // Read back through a DIFFERENT path than the one that wrote it.
    process.env.FMCODE_DIR = dir;
    assert.equal(await readCurrentToken('next'), 'access-token-value');
    assert.deepEqual(await readCachedIdentity('next'), {
      email: 'user@example.com',
      displayName: 'Test User',
    });
    assert.deepEqual(remembered, ['paste']);
  } finally {
    delete process.env.FMCODE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('paste method: continuing as A and coming back as B is wrong-account — and the token is STILL kept', async () => {
  const { terminal, dir } = await runPasteSignIn({
    identityEmail: 'someone-else@example.com',
    intent: { mode: 'continue', email: 'user@example.com' },
  });
  try {
    assert.equal(terminal.type, 'wrong-account');
    assert.equal(terminal.intended, 'user@example.com');
    assert.equal(terminal.actual, 'someone-else@example.com');

    // Kept deliberately: it is a valid grant for a real user, and the page —
    // not the transport — decides between "Keep" and "Switch account".
    process.env.FMCODE_DIR = dir;
    assert.equal(await readCurrentToken('next'), 'access-token-value');
  } finally {
    delete process.env.FMCODE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('paste method: an email that differs only in case is the SAME account, not a wrong-account', async () => {
  const { terminal, dir } = await runPasteSignIn({
    identityEmail: 'User@Example.com',
    intent: { mode: 'continue', email: 'user@example.com' },
  });
  try {
    assert.equal(terminal.type, 'success');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paste method: a failed token exchange is an error event, not a thrown exception', async () => {
  const { terminal, dir } = await runPasteSignIn({
    identityEmail: 'user@example.com',
    intent: { mode: 'fresh' },
    tokenStatus: 400,
  });
  try {
    assert.equal(terminal.type, 'error');
    assert.match(terminal.message, /token request failed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the intent reaches the authorize URL: continue sends login_hint, switch sends prompt=login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  try {
    const cont = startSignIn('next', { mode: 'continue', email: 'a@b.com' }, 'paste', log, {
      apiBase: fake.base,
      timeoutMs: 2000,
    });
    const contWaiting = await nextEvent(cont, (e) => e.type === 'waiting');
    const contUrl = new URL(contWaiting.authorizeUrl);
    assert.equal(contUrl.searchParams.get('login_hint'), 'a@b.com');
    assert.equal(contUrl.searchParams.get('prompt'), null);
    assert.equal(contUrl.searchParams.get('code_challenge_method'), 'S256');
    cont.cancel();

    const sw = startSignIn('next', { mode: 'switch' }, 'paste', log, { apiBase: fake.base, timeoutMs: 2000 });
    const swWaiting = await nextEvent(sw, (e) => e.type === 'waiting');
    const swUrl = new URL(swWaiting.authorizeUrl);
    assert.equal(swUrl.searchParams.get('prompt'), 'login');
    assert.equal(swUrl.searchParams.get('login_hint'), null);
    sw.cancel();
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel() emits cancelled once and nothing after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  try {
    const events = [];
    const session = startSignIn('next', { mode: 'fresh' }, 'paste', log, { apiBase: fake.base, timeoutMs: 2000 });
    session.onEvent((event) => events.push(event.type));
    await nextEvent(session, (e) => e.type === 'waiting');
    session.cancel();
    session.cancel();
    // A late paste after cancellation must not resurrect the session.
    session.submitPasted('code#state');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['waiting', 'cancelled']);
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a state mismatch on paste is an error, and NO token is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  try {
    const session = startSignIn('next', { mode: 'fresh' }, 'paste', log, { apiBase: fake.base, timeoutMs: 2000 });
    await nextEvent(session, (e) => e.type === 'waiting');
    const terminal = nextEvent(session, (e) => e.type !== 'waiting');
    session.submitPasted('the-code#not-the-state-we-sent');
    const event = await terminal;
    assert.equal(event.type, 'error');
    assert.match(event.message, /different "state"/);
    assert.equal(fake.seen.tokenRequests.length, 0, 'a mismatched state must never reach the token endpoint');
    assert.equal(await readCurrentToken('next'), undefined);
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('copyLink acts on the SAME authorize URL that was announced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  try {
    const session = startSignIn('next', { mode: 'fresh' }, 'paste', log, { apiBase: fake.base, timeoutMs: 2000 });
    const waiting = await nextEvent(session, (e) => e.type === 'waiting');
    await session.copyLink();
    const calls = globalThis.__fmmcpVscodeStub.calls;
    assert.equal(calls.clipboard.at(-1), waiting.authorizeUrl);
    session.cancel();
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The sign-in page selects the code-based card and must immediately show the
// REAL authorize URL — the one a copy would put on the clipboard. Selecting a
// card is not a request to launch anything, so the session is prepared and
// nothing is opened. The URL is inert until somebody visits it.
test('openBrowser:false PREPARES a session — a real authorize URL, and no browser opened', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  const before = globalThis.__fmmcpVscodeStub.calls.openExternal.length;
  try {
    const session = startSignIn('next', { mode: 'switch' }, 'paste', log, {
      apiBase: fake.base,
      timeoutMs: 2000,
      openBrowser: false,
    });
    const waiting = await nextEvent(session, (e) => e.type === 'waiting');
    assert.equal(globalThis.__fmmcpVscodeStub.calls.openExternal.length, before, 'nothing may be launched');
    const url = new URL(waiting.authorizeUrl);
    assert.equal(url.pathname, '/authorize');
    assert.ok(url.searchParams.get('client_id'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('code_challenge'));
    // §4: "Use a different account" is a `switch`, which must force the login form.
    assert.equal(url.searchParams.get('prompt'), 'login');
    // The URL is a REQUEST. Nothing that comes back from one may be in it.
    assert.equal(url.searchParams.get('code'), null);
    assert.equal(url.searchParams.get('code_verifier'), null);
    // Still a live session: the paste it is waiting for still works.
    session.cancel();
    assert.equal((await session.outcome()).type, 'cancelled');
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('outcome() resolves with the terminal event, including for a session that already finished', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-signin-'));
  const fake = await startFakeServer({ identityEmail: 'user@example.com' });
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = fake.base;
  process.env.FMCODE_OAUTH_CLIENT_ID = 'https://example.com/oauth/client.json';
  try {
    const session = startSignIn('next', { mode: 'fresh' }, 'paste', log, { apiBase: fake.base, timeoutMs: 5000 });
    const waiting = await nextEvent(session, (e) => e.type === 'waiting');
    const state = new URL(waiting.authorizeUrl).searchParams.get('state');
    session.submitPasted(`the-code#${state}`);
    const first = await session.outcome();
    assert.equal(first.type, 'success');
    // Asked again AFTER the fact — the shim may only reach for it late.
    assert.equal((await session.outcome()).type, 'success');
  } finally {
    delete process.env.FMCODE_DIR;
    delete process.env.FMCODE_OAUTH_ISSUER;
    delete process.env.FMCODE_OAUTH_CLIENT_ID;
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
