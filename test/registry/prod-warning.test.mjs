// Unit tests for the production-environment warning and the expiry recovery text.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/prod-warning.test.mjs
//
// From the 2026-09-04 blank-persona MCP test (RESULT-blank-persona-mcp-files.md):
//
//   F2 (MEDIUM, safety) — `activeEnv` resolves to `prod` by default and NOTHING
//     warned about it. A blank agent following `--help` would have driven live
//     customer data believing it was in a sandbox. PO 2026-09-03: the default
//     stays prod, so the fix is a WARNING, never a default change.
//   F4 (HIGH) — the expiry dead-end. `token mint` was removed on 2026-09-03
//     (ca49425), so no recovery text may still point at a mint or at
//     `token set` as the primary route; the route is `fmmcp-local login <env>`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENV, isProdEnv, prodWarning } from '../../dist/registry/environments.js';

test('DEFAULT_ENV is still prod — this fix must not change the default', () => {
  assert.equal(DEFAULT_ENV, 'prod', 'PO 2026-09-03: the default stays prod');
});

test('isProdEnv: identifies the production environment and nothing else', () => {
  assert.equal(isProdEnv('prod'), true);
  for (const env of ['sandbox', 'next', 'latest', 'custom']) {
    assert.equal(isProdEnv(env), false, `${env} must not be treated as production`);
  }
});

test('prodWarning: returns a warning for prod and undefined for every other env', () => {
  const warning = prodWarning('prod');
  assert.equal(typeof warning, 'string');
  assert.match(warning, /PRODUCTION/, 'the warning must say production unambiguously');
  assert.match(warning, /--env/, 'the warning must name the escape hatch');
  assert.equal(prodWarning('sandbox'), undefined);
  assert.equal(prodWarning('next'), undefined);
});

test('the CLI usage text warns that the default environment is production', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../dist/local-mcp/cli.js', import.meta.url), 'utf-8');
  const usageStart = src.indexOf('fmmcp-local — FortMesa Local MCP proxy');
  assert.ok(usageStart > -1, 'the USAGE block must exist');
  const usage = src.slice(usageStart, usageStart + 3000);
  assert.match(usage, /PRODUCTION/, '--help must state that the default env is production');
  assert.match(usage, /--env/, '--help already documents --env; it must be named as the escape hatch');
});

test('no user-facing recovery text points at the removed mint flow', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const rel of [
    '../../dist/local-mcp/cli.js',
    '../../dist/registry/scope-resolve.js',
    '../../dist/local-mcp/auth/token-provider.js',
  ]) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf-8');
    assert.equal(
      /mint one|token mint|Mint Fresh/i.test(src),
      false,
      `${rel} still offers a mint route — mint was removed in ca49425`,
    );
  }
});

test('a token-only environment says how to recover, without naming the removed mint command', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../dist/registry/oauth-provider.js', import.meta.url), 'utf-8');
  const i = src.indexOf('has no OAuth sign-in');
  assert.ok(i > -1, 'the token-only message must exist');
  const msg = src.slice(i - 200, i + 600);
  assert.match(msg, /token-only/, 'it must say why sign-in is unavailable');
  assert.match(msg, /token set/, 'it must name a recovery that still exists');
  assert.equal(/Mint Fresh Token/.test(msg), false, 'it must not name the removed command');
});

test('the missing-credentials error names `login`, not `token set`, as the primary route', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../dist/registry/scope-resolve.js', import.meta.url), 'utf-8');
  const i = src.indexOf('No credentials file found at');
  assert.ok(i > -1, 'the ENOENT message must exist');
  const msg = src.slice(i, i + 400);
  assert.match(msg, /fmmcp-local login/, 'the recovery must offer the OAuth sign-in route');
  assert.ok(
    msg.indexOf('fmmcp-local login') < msg.indexOf('token set'),
    'sign-in must be offered BEFORE the discouraged pasted-token route',
  );
});
