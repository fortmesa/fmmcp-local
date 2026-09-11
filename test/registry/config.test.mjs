// Unit tests for src/registry/config.ts (R7 · REVISION-PLAN.md).
//
// Run against the BUILT output (same convention as the sibling registry
// tests): `yarn build && yarn node --test test/registry/config.test.mjs`.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.
//
// Isolation: every test points `FMCODE_DIR` at a fresh temp directory
// (config.ts's own override convention, computed fresh on every call — see
// its `configDir()` doc comment) and cleans up afterward. The real
// `~/.fmcode` is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveEffectiveStartup } from '../../dist/registry/config.js';

/**
 * `DEFAULT_CONFIG` is intentionally not exported by config.ts (confirmed via
 * `grep export src/registry/config.ts`), so this is a hand-transcribed copy
 * of the literal at config.ts's `DEFAULT_CONFIG` for the purpose of
 * asserting `loadConfig()`'s first-run behavior. If config.ts's defaults
 * ever change, this constant must be updated by hand alongside it — there is
 * no structural way to enforce that without exporting `DEFAULT_CONFIG` from
 * the source module, which is out of scope for this test-only slice.
 */
const EXPECTED_DEFAULT_CONFIG = {
  version: 1,
  activeEnv: 'prod',
  scopeLock: { mode: 'unlocked', scopes: [] },
  environments: {
    sandbox: { gateway: 'http://localhost:3020/mcp' },
    next: { gateway: 'https://mcp-next.dev.fort.blue/mcp' },
    latest: { gateway: 'https://mcp-latest.dev.fort.blue/mcp' },
    prod: { gateway: 'https://mcp.fortmesa.com/mcp' },
  },
  ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
  logLevel: 'info',
  disabledTools: [],
  documentsMode: 'local',
};

/**
 * Run `fn` with `FMCODE_DIR` pointed at a fresh temp dir, so every test
 * deterministically operates on an isolated config.json instead of this
 * machine's real `~/.fmcode`. Cleans up and restores the env var afterward
 * even if `fn` throws. Mirrors test/registry/projectors/cursor.test.mjs's
 * `withIsolatedCursorHome` pattern.
 */
async function withIsolatedFmcodeDir(fn) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fortmesa-config-test-'));
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

function noopLog() {}

// --- Schema accept/reject -------------------------------------------------

test('loadConfig: throws a descriptive error when scopeLock.mode is not one of single/multi/unlocked', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const configPath = join(tmpDir, 'config.json');
    const badConfig = {
      version: 1,
      activeEnv: 'sandbox',
      scopeLock: { mode: 'bogus-mode', scopes: [] },
      environments: { sandbox: { gateway: 'http://localhost:3020/mcp' } },
      ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
      logLevel: 'info',
    };
    await writeFile(configPath, JSON.stringify(badConfig, null, 2), 'utf-8');

    await assert.rejects(
      () => loadConfig(),
      (error) => {
        assert.match(error.message, /Invalid config file/);
        assert.match(error.message, /scopeLock\.mode/);
        return true;
      },
    );
  });
});

test('loadConfig: throws a descriptive error when the "version" field is missing entirely', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const configPath = join(tmpDir, 'config.json');
    const badConfig = {
      activeEnv: 'sandbox',
      scopeLock: { mode: 'unlocked', scopes: [] },
      environments: { sandbox: { gateway: 'http://localhost:3020/mcp' } },
      ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
      logLevel: 'info',
    };
    await writeFile(configPath, JSON.stringify(badConfig, null, 2), 'utf-8');

    await assert.rejects(
      () => loadConfig(),
      (error) => {
        assert.match(error.message, /Invalid config file/);
        assert.match(error.message, /version/);
        return true;
      },
    );
  });
});

// --- resolveEffectiveStartup precedence -----------------------------------

function baseConfig(overrides = {}) {
  return {
    version: 1,
    activeEnv: 'sandbox',
    scopeLock: { mode: 'unlocked', scopes: [] },
    environments: {
      sandbox: { gateway: 'http://localhost:3020/mcp' },
      alt: { gateway: 'http://localhost:3099/mcp' },
    },
    ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
    logLevel: 'info',
    ...overrides,
  };
}

test('resolveEffectiveStartup: flags.env and flags.gateway override config.activeEnv/config.environments[env].gateway when both are present', () => {
  const config = baseConfig();
  const result = resolveEffectiveStartup({ env: 'alt', gateway: 'http://localhost:9999/mcp' }, config, noopLog);

  assert.equal(result.env, 'alt');
  assert.equal(result.gatewayUrl, 'http://localhost:9999/mcp');
});

test('resolveEffectiveStartup: when flags are absent, config.json values win (activeEnv + environments[env].gateway)', () => {
  const config = baseConfig();
  const result = resolveEffectiveStartup({}, config, noopLog);

  assert.equal(result.env, 'sandbox');
  assert.equal(result.gatewayUrl, 'http://localhost:3020/mcp');
});

test('resolveEffectiveStartup: flags.scopeLockNames === [] (explicit empty, flag PRESENT) produces unlocked effective startup even when config.scopeLock.mode is "single" with scopes populated', () => {
  const config = baseConfig({ scopeLock: { mode: 'single', scopes: ['grc-scope-one'] } });
  const result = resolveEffectiveStartup({ scopeLockNames: [] }, config, noopLog);

  assert.deepEqual(result.scopeLockNames, []);
});

test('resolveEffectiveStartup: flags.scopeLockNames === undefined (flag ABSENT) derives from config.scopeLock per mode — "unlocked"', () => {
  const config = baseConfig({ scopeLock: { mode: 'unlocked', scopes: ['ignored-when-unlocked'] } });
  const result = resolveEffectiveStartup({}, config, noopLog);

  assert.deepEqual(result.scopeLockNames, []);
});

test('resolveEffectiveStartup: flags.scopeLockNames === undefined derives from config.scopeLock per mode — "multi"', () => {
  const config = baseConfig({ scopeLock: { mode: 'multi', scopes: ['scope-a', 'scope-b'] } });
  const result = resolveEffectiveStartup({}, config, noopLog);

  assert.deepEqual(result.scopeLockNames, ['scope-a', 'scope-b']);
});

test('resolveEffectiveStartup: flags.scopeLockNames === undefined derives from config.scopeLock per mode — "single" with exactly one scope (no warning)', () => {
  const config = baseConfig({ scopeLock: { mode: 'single', scopes: ['only-scope'] } });
  const logs = [];
  const result = resolveEffectiveStartup({}, config, (msg) => logs.push(msg));

  assert.deepEqual(result.scopeLockNames, ['only-scope']);
  assert.deepEqual(logs, []);
});

test('resolveEffectiveStartup: "single" mode with scopes.length !== 1 logs a non-fatal warning and does NOT throw, using scopes as-is', () => {
  const config = baseConfig({ scopeLock: { mode: 'single', scopes: ['scope-a', 'scope-b'] } });
  const logs = [];

  const result = resolveEffectiveStartup({}, config, (msg) => logs.push(msg));

  assert.deepEqual(result.scopeLockNames, ['scope-a', 'scope-b']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /single/);
  assert.match(logs[0], /2/);
});

test('resolveEffectiveStartup: "single" mode with zero scopes also logs a warning and does not throw', () => {
  const config = baseConfig({ scopeLock: { mode: 'single', scopes: [] } });
  const logs = [];

  const result = resolveEffectiveStartup({}, config, (msg) => logs.push(msg));

  assert.deepEqual(result.scopeLockNames, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /single/);
});

test('resolveEffectiveStartup: throws a clear error when no gateway is configured for the resolved env and no --gateway flag is passed', () => {
  const config = baseConfig();
  assert.throws(
    () => resolveEffectiveStartup({ env: 'nonexistent' }, config, noopLog),
    (error) => {
      assert.match(error.message, /No gateway configured for env "nonexistent"/);
      return true;
    },
  );
});

// --- Default file creation under FMCODE_DIR -------------------------------

test('loadConfig: with no config.json present, creates one with default content and returns a matching Config', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const configPath = join(tmpDir, 'config.json');

    const result = await loadConfig();
    assert.deepEqual(result, EXPECTED_DEFAULT_CONFIG);

    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(onDisk, EXPECTED_DEFAULT_CONFIG);
  });
});
