// Unit tests for the identity display-derivation logic added for MFDV-244:
// the pure, vscode-free `identityPrimaryLabel` / `identityTooltip` helpers and
// the best-effort `fetchIdentity` REST lookup in src/registry/credentials.ts.
//
// Run against the BUILT output (same convention as the other registry suites):
//   yarn build && yarn node --test test/registry/identity-display.test.mjs
//
// No `vscode` stub loader is needed here — credentials.ts has no `vscode`
// import at all (it's registry code, shared by the CLI and the extension), so
// dist/registry/credentials.js loads directly under plain `yarn node --test`.
// The `fetchIdentity` cases run against a throwaway loopback http server, so
// they're hermetic (no real network, INV-HERMETIC-safe).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { identityPrimaryLabel, identityTooltip, fetchIdentity } from '../../dist/registry/credentials.js';

// ── Pure display derivation (the first-name-else-email rule) ──────────────

test('identityPrimaryLabel: the full displayName (PO 2026-09-03: lead the row with the user identity)', () => {
  assert.equal(identityPrimaryLabel({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1' }), 'John Doe');
});

test('identityPrimaryLabel: single-token displayName is used as-is', () => {
  assert.equal(identityPrimaryLabel({ email: 'jd@x.com', displayName: 'Madonna', userId: 'u1' }), 'Madonna');
});

test('identityPrimaryLabel: leading/inner/trailing whitespace is trimmed and collapsed', () => {
  assert.equal(identityPrimaryLabel({ email: 'jd@x.com', displayName: '  Jane   Smith ', userId: 'u1' }), 'Jane Smith');
});

test('identityPrimaryLabel: empty displayName falls back to email', () => {
  assert.equal(identityPrimaryLabel({ email: 'jd@x.com', displayName: '', userId: 'u1' }), 'jd@x.com');
});

test('identityPrimaryLabel: whitespace-only displayName falls back to email', () => {
  assert.equal(identityPrimaryLabel({ email: 'jd@x.com', displayName: '   ', userId: 'u1' }), 'jd@x.com');
});

// ── Tooltip derivation (email, plus provider only when present) ───────────

test('identityTooltip: email only when no identity provider is known', () => {
  assert.equal(identityTooltip({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1' }), 'jd@x.com');
});

test('identityTooltip: "<email> / <provider>" when a provider is present', () => {
  assert.equal(
    identityTooltip({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1', identityProvider: 'google' }),
    'jd@x.com / google',
  );
});

test('identityTooltip: empty provider string is treated as absent', () => {
  assert.equal(
    identityTooltip({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1', identityProvider: '' }),
    'jd@x.com',
  );
});

// ── fetchIdentity (parsing + mandatory graceful degradation) ──────────────

/** Spin up a one-shot loopback server that returns `handler(req)` and resolves to its base URL. */
async function withServer(handler, run) {
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('fetchIdentity: parses a well-formed /api/v2/me body', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/api/v2/me');
      assert.equal(req.headers.authorization, 'Bearer tok-123');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1', profileImage: 'p.png' }));
    },
    async (baseUrl) => {
      const identity = await fetchIdentity(baseUrl, 'tok-123');
      assert.deepEqual(identity, {
        email: 'jd@x.com',
        displayName: 'John Doe',
        userId: 'u1',
        profileImage: 'p.png',
      });
    },
  );
});

test('fetchIdentity: consumes a future `identityProvider` field when present', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'jd@x.com', displayName: 'John Doe', userId: 'u1', identityProvider: 'google' }));
    },
    async (baseUrl) => {
      const identity = await fetchIdentity(baseUrl, 'tok');
      assert.equal(identity?.identityProvider, 'google');
    },
  );
});

test('fetchIdentity: returns undefined on a 404 (endpoint not deployed off-sandbox)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end('not found');
    },
    async (baseUrl) => {
      assert.equal(await fetchIdentity(baseUrl, 'tok'), undefined);
    },
  );
});

test('fetchIdentity: returns undefined when the body has no usable email', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ displayName: 'John Doe', userId: 'u1' }));
    },
    async (baseUrl) => {
      assert.equal(await fetchIdentity(baseUrl, 'tok'), undefined);
    },
  );
});

test('fetchIdentity: returns undefined on a non-JSON body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('<html>not json</html>');
    },
    async (baseUrl) => {
      assert.equal(await fetchIdentity(baseUrl, 'tok'), undefined);
    },
  );
});

test('fetchIdentity: returns undefined (never throws) when the host is unreachable', async () => {
  // Nothing is listening on this port — the connect must fail into undefined.
  const identity = await fetchIdentity('http://127.0.0.1:1', 'tok');
  assert.equal(identity, undefined);
});
