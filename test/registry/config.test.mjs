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
import {
  loadConfig,
  loadConfigWithWarnings,
  onConfigWarnings,
  resolveEffectiveStartup,
  saveConfig,
} from '../../dist/registry/config.js';

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

// --- Tolerant load (FMDEV-879) ----------------------------------------------
//
// One invalid field must not make the whole config unloadable. A legacy
// `scopeLock.mode: "locked"` (seen on a real 27 Oct config) migrates to
// single/multi; any other invalid field falls back to its default with a
// warning. The scope lock is a guard, so its fallback is never `unlocked`
// unless the file itself said `unlocked`.

function fileConfig(overrides = {}) {
  return {
    version: 1,
    activeEnv: 'sandbox',
    scopeLock: { mode: 'unlocked', scopes: [] },
    environments: { sandbox: { gateway: 'http://localhost:3020/mcp' } },
    ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
    logLevel: 'info',
    disabledTools: [],
    documentsMode: 'local',
    ...overrides,
  };
}

async function writeConfigFile(tmpDir, config) {
  await writeFile(join(tmpDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

test('loadConfig: legacy scopeLock.mode "locked" with one scope loads as "single" and keeps every other field', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 'locked', scopes: ['fmlab2'] }, logLevel: 'debug' }));

    const config = await loadConfig();

    assert.deepEqual(config.scopeLock, { mode: 'single', scopes: ['fmlab2'] });
    assert.equal(config.activeEnv, 'sandbox');
    assert.equal(config.logLevel, 'debug');
  });
});

test('loadConfig: legacy scopeLock.mode "locked" with several scopes loads as "multi"', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 'locked', scopes: ['a', 'b'] } }));

    const config = await loadConfig();

    assert.deepEqual(config.scopeLock, { mode: 'multi', scopes: ['a', 'b'] });
  });
});

test('loadConfigWithWarnings: the legacy "locked" migration is reported as a warning', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 'locked', scopes: ['fmlab2'] } }));

    const { config, warnings } = await loadConfigWithWarnings();

    assert.equal(config.scopeLock.mode, 'single');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scopeLock\.mode/);
    assert.match(warnings[0], /locked/);
  });
});

test('loadConfig: the migrated value is written on the next save (no write on load itself)', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const configPath = join(tmpDir, 'config.json');
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 'locked', scopes: ['fmlab2'] } }));

    const config = await loadConfig();
    assert.equal(JSON.parse(await readFile(configPath, 'utf-8')).scopeLock.mode, 'locked');

    await saveConfig(config);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf-8')).scopeLock, { mode: 'single', scopes: ['fmlab2'] });
  });
});

test('loadConfig: a garbage scopeLock.mode falls back with a warning, fails CLOSED (never "unlocked")', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 'bogus-mode', scopes: ['fmlab2'] } }));

    const { config, warnings } = await loadConfigWithWarnings();

    assert.deepEqual(config.scopeLock, { mode: 'single', scopes: ['fmlab2'] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scopeLock\.mode/);
    assert.match(warnings[0], /bogus-mode/);
  });
});

test('loadConfig: a garbage scopeLock.mode with no scopes stays locked (every scope refused), not unlocked', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ scopeLock: { mode: 42, scopes: [] } }));

    const config = await loadConfig();

    assert.notEqual(config.scopeLock.mode, 'unlocked');
    assert.deepEqual(config.scopeLock.scopes, []);
    assert.equal(resolveEffectiveStartup({}, config, noopLog).scopeLocked, true);
  });
});

test('loadConfig: a missing scopeLock fails closed with a warning', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const raw = fileConfig();
    delete raw.scopeLock;
    await writeConfigFile(tmpDir, raw);

    const { config, warnings } = await loadConfigWithWarnings();

    assert.notEqual(config.scopeLock.mode, 'unlocked');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scopeLock/);
  });
});

test('loadConfig: an invalid logLevel falls back to its default; the rest of the config survives', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(
      tmpDir,
      fileConfig({ logLevel: 'loud', scopeLock: { mode: 'multi', scopes: ['a', 'b'] }, documentsMode: 'network' }),
    );

    const { config, warnings } = await loadConfigWithWarnings();

    assert.equal(config.logLevel, 'info');
    assert.deepEqual(config.scopeLock, { mode: 'multi', scopes: ['a', 'b'] });
    assert.equal(config.documentsMode, 'network');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /logLevel/);
  });
});

test('loadConfig: one invalid ideSync flag falls back alone; the other flags keep their values', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(
      tmpDir,
      fileConfig({
        ideSync: { claude: false, vscode: 'yes', cursor: false, codex: true, antigravity: false, copilot: false },
      }),
    );

    const { config, warnings } = await loadConfigWithWarnings();

    assert.deepEqual(config.ideSync, {
      claude: false,
      vscode: true,
      cursor: false,
      codex: true,
      antigravity: false,
      copilot: false,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ideSync\.vscode/);
  });
});

test('loadConfig: an invalid environments entry is dropped with a warning; valid entries survive', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(
      tmpDir,
      fileConfig({
        environments: { sandbox: { gateway: 'http://localhost:3020/mcp' }, broken: { gateway: '' } },
      }),
    );

    const { config, warnings } = await loadConfigWithWarnings();

    assert.deepEqual(Object.keys(config.environments), ['sandbox']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /environments\.broken/);
  });
});

test('loadConfig: a valid config produces no warnings', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig());

    const { warnings } = await loadConfigWithWarnings();

    assert.deepEqual(warnings, []);
  });
});

test('onConfigWarnings: listeners hear the warnings of a tolerant load, and stop after dispose', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeConfigFile(tmpDir, fileConfig({ logLevel: 'loud' }));
    const heard = [];
    const subscription = onConfigWarnings((warnings) => heard.push([...warnings]));

    await loadConfig();
    subscription.dispose();
    await loadConfig();

    assert.equal(heard.length, 1);
    assert.match(heard[0][0], /logLevel/);
  });
});

test('loadConfig: unparseable JSON still throws (nothing to salvage)', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeFile(join(tmpDir, 'config.json'), '{ not json', 'utf-8');

    await assert.rejects(() => loadConfig());
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
