// Unit tests for src/registry/token-refresh.ts and its wiring into
// resolveCredentials.
//
// Before this existed, `offline_access` was requested, the refresh token was
// stored, and nothing ever redeemed it: an expiring session just died. These
// tests pin the behaviour that replaced that, including the two cases that
// matter most and are easiest to get wrong -- rotation (the replacement
// refresh token must be persisted, or the NEXT refresh fails) and the race
// two processes hit when both refresh at once.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/token-refresh.test.mjs`.

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshIfExpiring } from '../../dist/registry/token-refresh.js';
import { resolveCredentials } from '../../dist/local-mcp/auth/token-provider.js';

const API_BASE = 'https://api-next.dev.fort.blue';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (expSeconds) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: expSeconds })}.sig`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A stand-in token endpoint, so nothing here touches the real tenant. */
async function withTokenServer(handler, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, body: Object.fromEntries(new URLSearchParams(body)) });
      handler(res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousIssuer = process.env.FMCODE_OAUTH_ISSUER;
  process.env.FMCODE_OAUTH_ISSUER = base;
  try {
    return await fn({ base, requests });
  } finally {
    if (previousIssuer === undefined) delete process.env.FMCODE_OAUTH_ISSUER;
    else process.env.FMCODE_OAUTH_ISSUER = previousIssuer;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withCredentials(block, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fortmesa-refresh-test-'));
  const previousDir = process.env.FMCODE_DIR;
  const previousToken = process.env.FORTMESA_API_TOKEN;
  process.env.FMCODE_DIR = dir;
  delete process.env.FORTMESA_API_TOKEN;

  await writeFile(join(dir, 'credentials.json'), JSON.stringify({ environments: { next: block } }));
  try {
    return await fn(dir);
  } finally {
    if (previousDir === undefined) delete process.env.FMCODE_DIR;
    else process.env.FMCODE_DIR = previousDir;
    if (previousToken !== undefined) process.env.FORTMESA_API_TOKEN = previousToken;
    await rm(dir, { recursive: true, force: true });
  }
}

const storedBlock = (token, refreshToken) => ({
  fortmesa_api_token: token,
  fortmesa_api_base: API_BASE,
  generated_at: 'unknown',
  expires_at: 'unknown',
  ...(refreshToken === undefined ? {} : { fortmesa_refresh_token: refreshToken }),
});

const readBlock = async (dir) => JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf-8')).environments.next;

const ok = (res, payload) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

test('refreshIfExpiring: does nothing while the token has plenty of life left', async () => {
  await withCredentials(storedBlock(jwt(nowSeconds() + 3600), 'refresh-1'), async () => {
    const outcome = await refreshIfExpiring('next', jwt(nowSeconds() + 3600), API_BASE);
    assert.equal(outcome.reason, 'not-needed');
  });
});

test('refreshIfExpiring: renews a token inside the 5 minute lead window', async () => {
  const expiring = jwt(nowSeconds() + 60);
  const replacement = jwt(nowSeconds() + 3600);

  await withCredentials(storedBlock(expiring, 'refresh-1'), async (dir) => {
    await withTokenServer(
      (res) => ok(res, { access_token: replacement, expires_in: 3600, refresh_token: 'refresh-2' }),
      async ({ requests }) => {
        const outcome = await refreshIfExpiring('next', expiring, API_BASE);
        assert.equal(outcome.reason, 'refreshed');
        assert.equal(outcome.token, replacement);

        assert.equal(requests[0].body.grant_type, 'refresh_token');
        assert.equal(requests[0].body.refresh_token, 'refresh-1');
        // RFC 8707: the renewed token must stay on the same audience.
        assert.equal(requests[0].body.resource, API_BASE);

        const block = await readBlock(dir);
        assert.equal(block.fortmesa_api_token, replacement);
        // Rotation: persisting the REPLACEMENT is what makes a second refresh
        // possible. Keeping the spent one is a session that dies next time.
        assert.equal(block.fortmesa_refresh_token, 'refresh-2');
      },
    );
  });
});

test('refreshIfExpiring: reports no-refresh-token rather than throwing', async () => {
  const expiring = jwt(nowSeconds() + 60);
  await withCredentials(storedBlock(expiring), async () => {
    assert.equal((await refreshIfExpiring('next', expiring, API_BASE)).reason, 'no-refresh-token');
  });
});

test('refreshIfExpiring: a rejected refresh token is reported, never thrown', async () => {
  const expiring = jwt(nowSeconds() + 60);
  await withCredentials(storedBlock(expiring, 'revoked'), async () => {
    await withTokenServer(
      (res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
      },
      async () => {
        const outcome = await refreshIfExpiring('next', expiring, API_BASE);
        assert.equal(outcome.reason, 'failed');
        assert.ok(outcome.error);
        assert.ok(!`${outcome.error}`.includes('revoked'), 'the outcome must not echo the refresh token');
      },
    );
  });
});

test('refreshIfExpiring: a lost rotation race adopts the winner token instead of failing', async () => {
  const expiring = jwt(nowSeconds() + 60);
  const winner = jwt(nowSeconds() + 3600);

  await withCredentials(storedBlock(expiring, 'refresh-1'), async (dir) => {
    await withTokenServer(
      async (res) => {
        // Another process got there first: our refresh token is already spent,
        // and a good token is on disk.
        await writeFile(
          join(dir, 'credentials.json'),
          JSON.stringify({ environments: { next: storedBlock(winner, 'refresh-3') } }),
        );
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
      },
      async () => {
        const outcome = await refreshIfExpiring('next', expiring, API_BASE);
        assert.equal(outcome.reason, 'raced');
        assert.equal(outcome.token, winner);
      },
    );
  });
});

test('resolveCredentials: renews an expiring token instead of rejecting it', async () => {
  // Inside the 30s gate AND inside the refresh window: without the refresh
  // wiring this call throws.
  const dying = jwt(nowSeconds() + 10);
  const replacement = jwt(nowSeconds() + 3600);

  await withCredentials(storedBlock(dying, 'refresh-1'), async () => {
    await withTokenServer(
      (res) => ok(res, { access_token: replacement, expires_in: 3600, refresh_token: 'refresh-2' }),
      async () => {
        const outcomes = [];
        const creds = await resolveCredentials('next', { onRefresh: (o) => outcomes.push(o) });
        assert.equal(creds.token, replacement);
        assert.deepEqual(
          outcomes.map((o) => o.reason),
          ['refreshed'],
        );
      },
    );
  });
});

test('resolveCredentials: still rejects an expired token when refresh cannot help', async () => {
  const dead = jwt(nowSeconds() - 3600);
  await withCredentials(storedBlock(dead), async () => {
    await assert.rejects(() => resolveCredentials('next'), /expired at /);
  });
});
