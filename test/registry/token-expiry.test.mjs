// Unit tests for the expiry gate in src/local-mcp/auth/token-provider.ts.
//
// resolveCredentials() is the single chokepoint every CLI subcommand and
// every Saferoom panel goes through to get a bearer token. Before this gate
// it handed back whatever credentials.json held, so an expired token reached
// the gateway and came back as an opaque 401 instead of "sign in again".
//
// The gate rejects only what it can PROVE is dead: a JWT whose `exp` has
// passed, or lands inside the skew margin. Opaque tokens and JWTs with no
// `exp` must still pass, because the paste and mint flows accept both.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/token-expiry.test.mjs`.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredentials } from '../../dist/local-mcp/auth/token-provider.js';
import { readCredentialsSummary } from '../../dist/registry/credentials.js';

const API_BASE = 'https://api-next.dev.fort.blue';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A structurally valid JWT with the given `exp` (seconds). `null` omits the claim. */
function jwt(expSeconds) {
  const payload = expSeconds === null ? { sub: 'u1' } : { sub: 'u1', exp: expSeconds };
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Point FMCODE_DIR at a fresh temp dir holding exactly one env block, and
 * clear FORTMESA_API_TOKEN so the env-var branch never shadows the file one.
 */
async function withStoredToken(token, fn, env = 'next') {
  const dir = await mkdtemp(join(tmpdir(), 'fortmesa-token-expiry-test-'));
  const previousDir = process.env.FMCODE_DIR;
  const previousToken = process.env.FORTMESA_API_TOKEN;
  process.env.FMCODE_DIR = dir;
  delete process.env.FORTMESA_API_TOKEN;

  await writeFile(
    join(dir, 'credentials.json'),
    JSON.stringify({
      environments: {
        [env]: {
          fortmesa_api_token: token,
          fortmesa_api_base: API_BASE,
          generated_at: 'unknown',
          expires_at: 'unknown',
        },
      },
    }),
  );

  try {
    await fn();
  } finally {
    if (previousDir === undefined) delete process.env.FMCODE_DIR;
    else process.env.FMCODE_DIR = previousDir;
    if (previousToken !== undefined) process.env.FORTMESA_API_TOKEN = previousToken;
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveCredentials: refuses a token that expired an hour ago', async () => {
  const token = jwt(nowSeconds() - 3600);
  await withStoredToken(token, async () => {
    await assert.rejects(() => resolveCredentials('next'), /expired at /);
  });
});

test('resolveCredentials: refuses a token expiring inside the skew margin', async () => {
  // Would pass a naive `exp > now` check, then 401 mid-request.
  const token = jwt(nowSeconds() + 10);
  await withStoredToken(token, async () => {
    await assert.rejects(() => resolveCredentials('next'), /inside the 30s safety margin/);
  });
});

test('resolveCredentials: accepts a token with an hour left', async () => {
  const token = jwt(nowSeconds() + 3600);
  await withStoredToken(token, async () => {
    const creds = await resolveCredentials('next');
    assert.equal(creds.token, token);
    assert.equal(creds.baseUrl, API_BASE);
  });
});

test('resolveCredentials: accepts a JWT carrying no exp claim (nothing to prove)', async () => {
  const token = jwt(null);
  await withStoredToken(token, async () => {
    const creds = await resolveCredentials('next');
    assert.equal(creds.token, token);
  });
});

test('resolveCredentials: accepts an opaque non-JWT token (paste/mint flows depend on this)', async () => {
  const token = 'fmtok_opaque_not_a_jwt';
  await withStoredToken(token, async () => {
    const creds = await resolveCredentials('next');
    assert.equal(creds.token, token);
  });
});

test('resolveCredentials: allowExpired still yields baseUrl for a dead token (the login path)', async () => {
  await withStoredToken(jwt(nowSeconds() - 3600), async () => {
    const creds = await resolveCredentials('next', { allowExpired: true });
    assert.equal(creds.baseUrl, API_BASE);
  });
});

test('resolveCredentials: the rejection message never contains the token', async () => {
  const token = jwt(nowSeconds() - 3600);
  await withStoredToken(token, async () => {
    const error = await resolveCredentials('next').then(
      () => undefined,
      (err) => err,
    );
    assert.ok(error, 'expected a rejection');
    assert.ok(!error.message.includes(token), 'rejection message leaked the token');
    // Nor any JWT segment of it.
    for (const segment of token.split('.')) {
      assert.ok(!error.message.includes(segment), `rejection message leaked a token segment: ${segment}`);
    }
  });
});

test('readCredentialsSummary: reports expired true/false from the stored token, never the token', async () => {
  await withStoredToken(jwt(nowSeconds() - 3600), async () => {
    const summary = await readCredentialsSummary('next');
    assert.equal(summary.hasToken, true);
    assert.equal(summary.expired, true);
    assert.equal(Object.hasOwn(summary, 'fortmesa_api_token'), false);
  });

  await withStoredToken(jwt(nowSeconds() + 3600), async () => {
    assert.equal((await readCredentialsSummary('next')).expired, false);
  });
});

test('readCredentialsSummary: expired is undefined when the token carries no exp', async () => {
  await withStoredToken('fmtok_opaque_not_a_jwt', async () => {
    const summary = await readCredentialsSummary('next');
    assert.equal(summary.hasToken, true);
    assert.equal(summary.expired, undefined);
  });
});

// ── Environment-aware recovery line (MFDV-246, VSIX feedback 2026-09-05) ──
//
// Before this, the expired-token message always said `fmmcp-local login
// <env>`, even for `sandbox`, which has no `clientId` and therefore no OAuth
// login to run — a dead end the round's UI work (item 4) had just removed
// from the Saferoom sidebar. The message is now routed the same way
// `registry/session-status.ts` routes the Signed-in user pane:
// `hasOAuthSignIn(env)` picks sign-in vs. token-replacement wording.

test('resolveCredentials: OAuth-capable env (has clientId) is told to sign in', async () => {
  const token = jwt(nowSeconds() - 3600);
  await withStoredToken(
    token,
    async () => {
      await assert.rejects(
        () => resolveCredentials('next'),
        /Your session has expired\. Run `fmmcp-local login next` \(or use Sign In in the FortMesa sidebar\)\./,
      );
    },
    'next',
  );
});

test('resolveCredentials: token-only env (no clientId, e.g. sandbox) is told to replace the token, never to log in', async () => {
  const token = jwt(nowSeconds() - 3600);
  await withStoredToken(
    token,
    async () => {
      const error = await resolveCredentials('sandbox').then(
        () => undefined,
        (err) => err,
      );
      assert.ok(error, 'expected a rejection');
      assert.match(
        error.message,
        /Your sandbox access token has expired\. Paste a new one in Settings › Identity › Advanced, or run `fmmcp-local token set sandbox`\./,
      );
      assert.ok(!error.message.includes('login sandbox'), 'must not point sandbox at the OAuth login dead end');
    },
    'sandbox',
  );
});
