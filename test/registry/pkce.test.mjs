// Unit tests for src/registry/pkce.ts.
//
// Run against the BUILT output (same convention as
// test/registry/projectors/codex.test.mjs / scripts/test-runner.mjs):
//   yarn build && yarn node test/registry/pkce.test.mjs
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildAuthorizeUrl,
  deriveChallenge,
  exchangeCodeForToken,
  generatePkcePair,
  refreshAccessToken,
} from '../../dist/registry/pkce.js';

// RFC 7636 Appendix B.1's own worked example: a fixed code_verifier and the
// code_challenge it MUST produce under the S256 transform
// (BASE64URL(SHA256(ASCII(verifier)))). This is the citable "known verifier
// -> known challenge" vector the task asks for — not fabricated.
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('deriveChallenge: matches the RFC 7636 Appendix B.1 worked example', () => {
  assert.equal(deriveChallenge(RFC7636_VERIFIER), RFC7636_CHALLENGE);
});

test('deriveChallenge: deterministic for the same verifier', () => {
  const a = deriveChallenge(RFC7636_VERIFIER);
  const b = deriveChallenge(RFC7636_VERIFIER);
  assert.equal(a, b);
});

test('generatePkcePair: verifier/challenge are valid base64url, and the challenge matches deriveChallenge(verifier)', () => {
  const pair = generatePkcePair();
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;

  assert.equal(pair.method, 'S256');
  assert.match(pair.verifier, base64urlPattern, 'verifier must be base64url (no +, /, or = padding)');
  assert.ok(
    pair.verifier.length >= 43 && pair.verifier.length <= 128,
    'verifier length must be within RFC 7636 §4.1 bounds',
  );

  assert.match(pair.challenge, base64urlPattern, 'challenge must be base64url (no +, /, or = padding)');
  // A base64url-encoded SHA-256 digest (32 bytes) is always exactly 43
  // characters with no padding.
  assert.equal(pair.challenge.length, 43);
  assert.equal(pair.challenge, deriveChallenge(pair.verifier));
});

test('generatePkcePair: two calls never produce the same verifier', () => {
  const a = generatePkcePair();
  const b = generatePkcePair();
  assert.notEqual(a.verifier, b.verifier);
});

test('buildAuthorizeUrl: builds the expected path + query, percent-encoding every param via URLSearchParams', () => {
  const url = buildAuthorizeUrl('http://localhost:3010', {
    clientId: 'fortmesa-saferoom',
    redirectUri: 'http://127.0.0.1:43117/callback',
    codeChallenge: RFC7636_CHALLENGE,
    state: 'a state with spaces & an &',
  });

  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'http://localhost:3010/authorize');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('client_id'), 'fortmesa-saferoom');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:43117/callback');
  assert.equal(parsed.searchParams.get('code_challenge'), RFC7636_CHALLENGE);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), 'a state with spaces & an &');
});

test('buildAuthorizeUrl: sends prompt=login only for "Use a different account"', () => {
  // Without it an existing tenant SSO session silently returns the SAME
  // identity the user is trying to leave — the whole point of the button.
  const withPrompt = new URL(
    buildAuthorizeUrl('https://auth.example.com', {
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:43117/callback',
      codeChallenge: 'ch',
      state: 'st',
      prompt: 'login',
    }),
  );
  assert.equal(withPrompt.searchParams.get('prompt'), 'login');

  const without = new URL(
    buildAuthorizeUrl('https://auth.example.com', {
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:43117/callback',
      codeChallenge: 'ch',
      state: 'st',
    }),
  );
  assert.equal(without.searchParams.get('prompt'), null);
});

test('buildAuthorizeUrl: sends login_hint for "Continue as", percent-encoded, and omits an empty one', () => {
  const url = new URL(
    buildAuthorizeUrl('https://auth.example.com', {
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:43117/callback',
      codeChallenge: 'ch',
      state: 'st',
      loginHint: 'a b+c@example.com',
    }),
  );
  assert.equal(url.searchParams.get('login_hint'), 'a b+c@example.com');
  assert.match(url.search, /login_hint=a\+b%2Bc%40example.com/);

  const empty = new URL(
    buildAuthorizeUrl('https://auth.example.com', {
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:43117/callback',
      codeChallenge: 'ch',
      state: 'st',
      loginHint: '',
    }),
  );
  assert.equal(empty.searchParams.get('login_hint'), null);
});

test('buildAuthorizeUrl: strips a trailing slash from apiBase before appending /authorize', () => {
  const url = buildAuthorizeUrl('http://localhost:3010/', {
    clientId: 'c',
    redirectUri: 'http://127.0.0.1:43117/callback',
    codeChallenge: 'x',
    state: 'y',
  });
  assert.ok(url.startsWith('http://localhost:3010/authorize?'), url);
});

/** Start a throwaway HTTP server for the exchangeCodeForToken tests below; resolves with { url, requests, close }, where `requests` accumulates `{method, path, headers, bodyText}` for every request received. */
function startFakeTokenServer(handler) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        requests.push({ method: req.method, path: req.url, headers: req.headers, bodyText });
        handler(req, res, bodyText);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('exchangeCodeForToken: POSTs a form-encoded body with grant_type=authorization_code, every PKCE param, and the resource indicator, and returns the parsed token (incl. refresh_token) on 200', async () => {
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'the-access-token', expires_in: 3600, refresh_token: 'the-refresh-token' }));
  });

  try {
    const result = await exchangeCodeForToken(fake.url, {
      clientId: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
      redirectUri: 'http://127.0.0.1:43117/callback',
      code: 'the-code',
      codeVerifier: 'the-verifier',
      resource: 'https://api-next.dev.fort.blue',
    });

    assert.deepEqual(result, {
      access_token: 'the-access-token',
      expires_in: 3600,
      refresh_token: 'the-refresh-token',
    });
    assert.equal(fake.requests.length, 1);
    const received = fake.requests[0];
    assert.equal(received.method, 'POST');
    assert.equal(received.path, '/oauth/token');
    // Form-encoded, not JSON: Auth0's token endpoint requires it, and
    // fmweb-be's oAuthToken handler accepts both.
    assert.equal(received.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(received.bodyText)), {
      grant_type: 'authorization_code',
      client_id: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
      redirect_uri: 'http://127.0.0.1:43117/callback',
      code: 'the-code',
      code_verifier: 'the-verifier',
      resource: 'https://api-next.dev.fort.blue',
    });
  } finally {
    await fake.close();
  }
});

test('exchangeCodeForToken: omits refresh_token from the result when the server returns none, and omits resource from the body when not provided', async () => {
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'the-access-token', expires_in: 3600 }));
  });

  try {
    const result = await exchangeCodeForToken(fake.url, {
      clientId: 'fortmesa-saferoom',
      redirectUri: 'http://127.0.0.1:43117/callback',
      code: 'the-code',
      codeVerifier: 'the-verifier',
    });

    assert.deepEqual(result, { access_token: 'the-access-token', expires_in: 3600 });
    const body = Object.fromEntries(new URLSearchParams(fake.requests[0].bodyText));
    assert.equal('resource' in body, false);
  } finally {
    await fake.close();
  }
});

test('refreshAccessToken: POSTs grant_type=refresh_token with the resource indicator and returns the rotated refresh token', async () => {
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'new-access', expires_in: 3600, refresh_token: 'rotated-refresh' }));
  });

  try {
    const result = await refreshAccessToken(fake.url, {
      clientId: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
      refreshToken: 'old-refresh',
      resource: 'https://api-next.dev.fort.blue',
    });

    assert.deepEqual(result, { access_token: 'new-access', expires_in: 3600, refresh_token: 'rotated-refresh' });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(fake.requests[0].bodyText)), {
      grant_type: 'refresh_token',
      client_id: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
      refresh_token: 'old-refresh',
      resource: 'https://api-next.dev.fort.blue',
    });
  } finally {
    await fake.close();
  }
});

test('exchangeCodeForToken: throws a clear Error including the response body text on a non-2xx response', async () => {
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_client', error_description: 'client_secret or code_verifier missing' }));
  });

  try {
    await assert.rejects(
      () =>
        exchangeCodeForToken(fake.url, {
          clientId: 'fortmesa-saferoom',
          redirectUri: 'http://127.0.0.1:43117/callback',
          code: 'the-code',
          codeVerifier: 'the-verifier',
        }),
      (error) => {
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /invalid_client/);
        assert.match(error.message, /client_secret or code_verifier missing/);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('exchangeCodeForToken: throws a clear Error when a 200 response is missing access_token/expires_in', async () => {
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await assert.rejects(
      () =>
        exchangeCodeForToken(fake.url, {
          clientId: 'fortmesa-saferoom',
          redirectUri: 'http://127.0.0.1:43117/callback',
          code: 'the-code',
          codeVerifier: 'the-verifier',
        }),
      /access_token/,
    );
  } finally {
    await fake.close();
  }
});

// -- failure modes that must not become silent or leaky ---------------------

test('exchangeCodeForToken: a failure never echoes the verifier or the code', async () => {
  // The error text is logged and shown to the user. A code_verifier in it is
  // the one secret a public client holds.
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });

  try {
    await assert.rejects(
      () =>
        exchangeCodeForToken(fake.url, {
          clientId: 'fortmesa-saferoom',
          redirectUri: 'http://127.0.0.1:43117/callback',
          code: 'SECRET-CODE',
          codeVerifier: 'SECRET-VERIFIER',
        }),
      (error) => {
        assert.ok(!error.message.includes('SECRET-VERIFIER'), 'the verifier must never reach a log line');
        assert.ok(!error.message.includes('SECRET-CODE'), 'nor the authorization code');
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('refreshAccessToken: an empty refresh_token is dropped rather than stored over a good one', async () => {
  // writeToken persists whatever comes back. Storing "" would wipe the live
  // refresh token and force a full re-login on the next expiry.
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'AT', expires_in: 60, refresh_token: '' }));
  });

  try {
    const out = await refreshAccessToken(fake.url, { clientId: 'c', refreshToken: 'OLD' });
    assert.deepEqual(out, { access_token: 'AT', expires_in: 60 });
  } finally {
    await fake.close();
  }
});

test('refreshAccessToken: a 2xx that is not JSON is rejected, not treated as a token', async () => {
  // A captive portal or a proxy error page returns 200 with HTML.
  const fake = await startFakeTokenServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>proxy error</html>');
  });

  try {
    await assert.rejects(() => refreshAccessToken(fake.url, { clientId: 'c', refreshToken: 'OLD' }), /not valid JSON/);
  } finally {
    await fake.close();
  }
});

test('refreshAccessToken: every half-built 2xx body is rejected', async () => {
  for (const body of [{}, { access_token: 'AT' }, { expires_in: 60 }, { access_token: 1, expires_in: 60 }, []]) {
    const fake = await startFakeTokenServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    try {
      await assert.rejects(
        () => refreshAccessToken(fake.url, { clientId: 'c', refreshToken: 'OLD' }),
        /missing "access_token"\/"expires_in"/,
        JSON.stringify(body),
      );
    } finally {
      await fake.close();
    }
  }
});

test('refreshAccessToken: an unreachable endpoint names the url instead of surfacing a bare TypeError', async () => {
  // `fetch` rejects with "fetch failed" and nothing else, which tells a user
  // running against a custom base absolutely nothing.
  const fake = await startFakeTokenServer(() => undefined);
  const deadUrl = fake.url;
  await fake.close();

  await assert.rejects(
    () => refreshAccessToken(deadUrl, { clientId: 'c', refreshToken: 'OLD' }),
    new RegExp(`could not reach ${deadUrl.replace(/[.]/g, '\\.')}/oauth/token`),
  );
});
