// Unit tests for src/registry/environments.ts (UX-ROUND-2-PLAN.md W2): the
// single hardcoded source of truth for the four FortMesa environments'
// gateway + app URLs, and the two-place drift it's meant to kill —
// config.ts's DEFAULT_CONFIG.environments vs package.json's
// fortmesa.environments setting default previously disagreed (both were
// hand-maintained, separate 3-env lists missing "latest").
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/environments.test.mjs`.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_API_BASE,
  DEFAULT_ENV,
  ENVIRONMENTS,
  PROD_ONLY_BUILD,
  gatewayDefaults,
  isSelectableEnv,
  deriveDataRegion,
  registerDataRegion,
} from '../../dist/registry/environments.js';
import { loadConfig } from '../../dist/registry/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

const EXPECTED_ENV_NAMES = ['sandbox', 'next', 'latest', 'prod'];

/**
 * Run `fn` with `FMCODE_DIR` pointed at a fresh temp dir, so `loadConfig()`
 * always exercises the real first-run `DEFAULT_CONFIG` path (ENOENT ->
 * `saveConfig(DEFAULT_CONFIG)`) instead of this machine's real `~/.fmcode`.
 * Mirrors config.test.mjs's `withIsolatedFmcodeDir`.
 */
async function withIsolatedFmcodeDir(fn) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fortmesa-environments-test-'));
  const previous = process.env.FMCODE_DIR;
  process.env.FMCODE_DIR = tmpDir;

  try {
    await fn(tmpDir);
  } finally {
    if (previous === undefined) {
      delete process.env.FMCODE_DIR;
    } else {
      process.env.FMCODE_DIR = previous;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test('ENVIRONMENTS: has exactly the four expected envs, each with both gateway and app', () => {
  assert.deepEqual(Object.keys(ENVIRONMENTS).sort(), [...EXPECTED_ENV_NAMES].sort());
  for (const name of EXPECTED_ENV_NAMES) {
    const entry = ENVIRONMENTS[name];
    assert.ok(entry, `expected an entry for "${name}"`);
    assert.equal(typeof entry.gateway, 'string');
    assert.ok(entry.gateway.length > 0, `"${name}".gateway should be non-empty`);
    assert.equal(typeof entry.app, 'string');
    assert.ok(entry.app.length > 0, `"${name}".app should be non-empty`);
  }
});

test('gatewayDefaults(): is exactly what a fresh loadConfig() writes as DEFAULT_CONFIG.environments', async () => {
  await withIsolatedFmcodeDir(async () => {
    const config = await loadConfig();
    assert.deepEqual(config.environments, gatewayDefaults());
  });
});

test('gatewayDefaults(): shape is { gateway } only, no app (app is Saferoom-UI-only, never in config.json)', () => {
  const defaults = gatewayDefaults();
  assert.deepEqual(Object.keys(defaults).sort(), [...EXPECTED_ENV_NAMES].sort());
  for (const entry of Object.values(defaults)) {
    assert.deepEqual(Object.keys(entry), ['gateway']);
  }
});

test('package.json fortmesa.environments default matches environments.ts gatewayDefaults() exactly (kills the two-place drift)', () => {
  const packageDefault = packageJson.contributes.configuration.properties['fortmesa.environments'].default;
  assert.deepEqual(packageDefault, gatewayDefaults());
});

// ── Prod-only build flag ──────────────────────────────────────────────────
// These run against dist/ (tsc output). Nothing defines
// __FORTMESA_PROD_ONLY__ there, so every guarded expression must take the
// non-prod branch. A botched guard — dropping the `typeof`, inverting the
// test, reading the flag through a shared binding — shows up here as the
// tsc build silently behaving like a prod-only build.
//
// The stripping itself is a bundler behaviour and cannot be asserted from
// here; `scripts/verify-prod-strip.mjs` greps the built bundles for that.

test('prod-only flag: the tsc build is never a prod-only build', () => {
  assert.equal(PROD_ONLY_BUILD, false);
});

test('prod-only flag: unset, DEFAULT_ENV is prod and every environment is present', () => {
  // 2026-09-03 (PO): production is the default in every build, not just a
  // prod-only one — supersedes the earlier per-build sandbox/prod default.
  assert.equal(DEFAULT_ENV, 'prod');
  assert.deepEqual(Object.keys(ENVIRONMENTS).sort(), [...EXPECTED_ENV_NAMES].sort());
});

test("prod-only flag: unset, DEFAULT_API_BASE is prod's api verbatim (tracks DEFAULT_ENV)", () => {
  assert.equal(DEFAULT_API_BASE, ENVIRONMENTS.prod.api);
});

test('prod-only flag: DEFAULT_ENV names a real entry in ENVIRONMENTS', () => {
  assert.ok(ENVIRONMENTS[DEFAULT_ENV], `DEFAULT_ENV "${DEFAULT_ENV}" must exist in ENVIRONMENTS`);
});

test('prod-only flag: unset, every environment is selectable, including a custom one', () => {
  for (const name of EXPECTED_ENV_NAMES) assert.equal(isSelectableEnv(name), true);
  // A user-added gateway in config.json stays usable in a normal build.
  assert.equal(isSelectableEnv('my-own-gateway'), true);
});

// ── Data region override (the MCPB's single user_config field) ────────────
//
// The point of these: a bare API base cannot carry a data region. The gateway,
// the OAuth identity and the credentials key are all keyed off the environment
// entry, so the override has to produce a WHOLE entry or it describes two
// different places at once.

test('data region: one URL moves the gateway, the API base and the OAuth identity together', () => {
  const { name, entry } = deriveDataRegion('https://api.eu.fortmesa.com');

  assert.equal(entry.api, 'https://api.eu.fortmesa.com');
  // The gateway is the half a bare API base override silently left on production.
  assert.equal(entry.gateway, 'https://mcp.eu.fortmesa.com/mcp');
  assert.equal(entry.app, 'https://eu.fortmesa.com/');
  assert.equal(entry.clientId, 'https://eu.fortmesa.com/oauth/saferoom-client-metadata.json');
  assert.equal(entry.hostedCallback, 'https://eu.fortmesa.com/a/auth/saferoom/callback');
  // Absent, not false: whether that region's app routes the first-land page is
  // a per-deploy fact this cannot know.
  assert.equal(entry.firstLandPage, undefined);
  // Distinct from "prod", so two regions never overwrite each other's credentials.
  assert.notEqual(name, 'prod');
  assert.match(name, /^region-api\.eu\.fortmesa\.com$/);
});

test('data region: the derivation reproduces production exactly, and resolves to it', () => {
  // The same rule applied to production's own address must yield production's
  // real gateway/app/client — that is the evidence the convention is not a guess.
  const { name, entry } = deriveDataRegion('https://api.fortmesa.com');
  assert.equal(name, 'prod');
  assert.equal(entry, ENVIRONMENTS.prod);
});

test('data region: anything that is not a FortMesa data region address is REFUSED', () => {
  // Refusing is the safe outcome: a looser rule would send a bearer token to a
  // host the user never named.
  assert.throws(() => deriveDataRegion('ftp://nope'), /not a valid URL|must use https/);
  assert.throws(() => deriveDataRegion('http://api.example.com'), /must use https/);
  assert.throws(() => deriveDataRegion('https://example.com'), /must start with\s+"api\."/s);
  assert.throws(() => deriveDataRegion('https://api.example.com/v2'), /drop the path/);
});

test('data region: registering one makes every environment-keyed lookup resolve it', () => {
  const { name, entry } = registerDataRegion('https://api.test-region.example.com');
  assert.equal(ENVIRONMENTS[name], entry);
  assert.equal(isSelectableEnv(name), true);
  delete ENVIRONMENTS[name];
});
