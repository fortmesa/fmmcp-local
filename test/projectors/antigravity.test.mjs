#!/usr/bin/env node
/**
 * Fixture-based unit tests for src/registry/projectors/antigravity.ts
 * (VSIX-PLAN.md §3.3 row 5; curriculum 04-ide-integration-matrix.md §5;
 * 08-pitfalls-log.md #12).
 *
 * Runs against the BUILT module (`dist/registry/projectors/antigravity.js`)
 * — mirrors this repo's existing convention of testing compiled output
 * (scripts/hot-reload-test.mjs, scripts/test-runner.mjs both drive
 * `dist/local-mcp/cli.js`) rather than executing .ts sources directly.
 *
 * Usage:
 *   yarn build && node --test test/projectors/antigravity.test.mjs
 *
 * Isolation: every test points GEMINI_HOME_DIR at a fresh temp directory
 * (mirrors src/registry/config.ts's FMCODE_DIR override convention) and
 * cleans it up afterwards — the real ~/.gemini is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const { detect, project } = await import(join(repoRoot, 'dist', 'registry', 'projectors', 'antigravity.js'));

const FIXTURE_PATH = join(repoRoot, 'test', 'fixtures', 'ide-configs', 'antigravity-mcp-config.json');
const SPEC = { command: '/workspaces/fmmcp-local/launch-mcp.sh', args: [] };
const EXPECTED_RESTART_NOTE =
  'use the Installed MCP Servers Refresh button, or the /mcp manager reload, or restart the IDE — Antigravity does not auto-detect config file changes';

function configPath(home) {
  return join(home, 'config', 'mcp_config.json');
}

/** Load the checked-in dirty fixture (real-world fortmesa-sandbox/fortmesa-next shape + a synthetic unrelated top-level key). Returns a fresh parse every call so tests can't leak mutations into each other. */
async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf-8'));
}

async function writeConfig(home, data) {
  const path = configPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

async function readConfig(home) {
  return JSON.parse(await readFile(configPath(home), 'utf-8'));
}

/** True if `path` exists (file or dir), false on ENOENT, rethrows anything else. */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Create an isolated fake "home" dir, point GEMINI_HOME_DIR at it for the duration of `fn`, then clean up. Never touches the real ~/.gemini. */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'fmmcp-antigravity-test-'));
  const previous = process.env.GEMINI_HOME_DIR;
  process.env.GEMINI_HOME_DIR = home;
  try {
    await fn(home);
  } finally {
    if (previous === undefined) {
      delete process.env.GEMINI_HOME_DIR;
    } else {
      process.env.GEMINI_HOME_DIR = previous;
    }
    await rm(home, { recursive: true, force: true });
  }
}

// ── detect() ──────────────────────────────────────────────────────

test('detect() is false when neither the ~/.gemini home dir nor the config file exist', async () => {
  await withTempHome(async (home) => {
    await rm(home, { recursive: true, force: true }); // mkdtemp creates it; simulate "not installed"
    assert.equal(await detect(), false);
  });
});

test('detect() is true when the ~/.gemini home dir exists but no MCP config has been written yet', async () => {
  await withTempHome(async () => {
    // mkdtemp already created the home dir itself and nothing else.
    assert.equal(await detect(), true);
  });
});

test('detect() is true when the config file exists', async () => {
  await withTempHome(async (home) => {
    await writeConfig(home, await loadFixture());
    assert.equal(await detect(), true);
  });
});

// ── project(): enabling on the dirty real-world fixture ────────────

test('project(spec, true) adds "fortmesa" and leaves fortmesa-sandbox/fortmesa-next/foreign keys byte-identical', async () => {
  await withTempHome(async (home) => {
    const original = await loadFixture();
    await writeConfig(home, original);

    const result = await project(SPEC, true);

    assert.equal(result.target, 'antigravity');
    assert.equal(result.action, 'added');
    assert.equal(result.restartNote, EXPECTED_RESTART_NOTE);

    const after = await readConfig(home);

    // The one key we're allowed to touch.
    assert.deepEqual(after.mcpServers.fortmesa, { command: SPEC.command, args: [] });

    // Everything else survives untouched, byte-for-byte.
    assert.deepEqual(after.mcpServers['fortmesa-sandbox'], original.mcpServers['fortmesa-sandbox']);
    assert.deepEqual(after.mcpServers['fortmesa-next'], original.mcpServers['fortmesa-next']);
    assert.deepEqual(after.mcpServers['atlassian-mcp-server'], original.mcpServers['atlassian-mcp-server']);
    assert.deepEqual(after.mcpServers['chrome-devtools'], original.mcpServers['chrome-devtools']);
    assert.equal(after.__testUnrelatedTopLevelSetting, original.__testUnrelatedTopLevelSetting);
    assert.equal(Object.keys(after.mcpServers).length, Object.keys(original.mcpServers).length + 1);
  });
});

test('project(spec, true) is idempotent: second call reports "unchanged" and does not touch the entry', async () => {
  await withTempHome(async (home) => {
    await writeConfig(home, await loadFixture());

    const first = await project(SPEC, true);
    assert.equal(first.action, 'added');

    const second = await project(SPEC, true);
    assert.equal(second.action, 'unchanged');
    assert.equal(second.restartNote, EXPECTED_RESTART_NOTE);

    const after = await readConfig(home);
    assert.deepEqual(after.mcpServers.fortmesa, { command: SPEC.command, args: [] });
  });
});

test('project(spec, true) strips a stale "disabled": true left over from a prior opt-out', async () => {
  await withTempHome(async (home) => {
    const original = await loadFixture();
    await writeConfig(home, {
      ...original,
      mcpServers: {
        ...original.mcpServers,
        fortmesa: { command: SPEC.command, args: [], disabled: true },
      },
    });

    const result = await project(SPEC, true);
    assert.equal(result.action, 'updated');

    const after = await readConfig(home);
    assert.deepEqual(after.mcpServers.fortmesa, { command: SPEC.command, args: [] });
    assert.equal('disabled' in after.mcpServers.fortmesa, false);
    // Foreign keys still untouched.
    assert.deepEqual(after.mcpServers['fortmesa-sandbox'], original.mcpServers['fortmesa-sandbox']);
    assert.deepEqual(after.mcpServers['fortmesa-next'], original.mcpServers['fortmesa-next']);
  });
});

// ── project(): disabling (opt-out) — Antigravity's differing semantics ──

test('project(spec, false) on a fresh fixture CREATES a disabled:true entry rather than doing nothing', async () => {
  await withTempHome(async (home) => {
    const original = await loadFixture();
    await writeConfig(home, original);

    const result = await project(SPEC, false);
    assert.equal(result.action, 'added');
    assert.equal(result.restartNote, EXPECTED_RESTART_NOTE);

    const after = await readConfig(home);
    assert.deepEqual(after.mcpServers.fortmesa, { command: SPEC.command, args: [], disabled: true });
    assert.deepEqual(after.mcpServers['fortmesa-sandbox'], original.mcpServers['fortmesa-sandbox']);
    assert.deepEqual(after.mcpServers['fortmesa-next'], original.mcpServers['fortmesa-next']);
  });
});

test('project(spec, false) with NO ~/.gemini present at all is a true no-op (skipped, no file created)', async () => {
  await withTempHome(async (home) => {
    await rm(home, { recursive: true, force: true }); // mkdtemp creates it; simulate "not installed"

    const result = await project(SPEC, false);
    assert.equal(result.action, 'skipped');
    assert.equal(result.restartNote, EXPECTED_RESTART_NOTE);

    assert.equal(await pathExists(configPath(home)), false);
    assert.equal(await pathExists(home), false);
  });
});

test('project(spec, false) on an enabled entry sets disabled:true WITHOUT deleting the entry', async () => {
  await withTempHome(async (home) => {
    await writeConfig(home, await loadFixture());
    await project(SPEC, true);

    const result = await project(SPEC, false);
    assert.equal(result.action, 'updated');

    const after = await readConfig(home);
    // Entry stays present — this is the behavior that differs from every
    // other Phase P1 projector (claude/cursor/codex delete on disable).
    assert.ok('fortmesa' in after.mcpServers);
    assert.deepEqual(after.mcpServers.fortmesa, { command: SPEC.command, args: [], disabled: true });
  });
});

test('project(spec, false) is idempotent once already disabled', async () => {
  await withTempHome(async (home) => {
    await writeConfig(home, await loadFixture());
    await project(SPEC, false);

    const second = await project(SPEC, false);
    assert.equal(second.action, 'unchanged');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

test('project() creates config/mcp_config.json and its parent dir from scratch when only ~/.gemini exists', async () => {
  await withTempHome(async (home) => {
    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const after = await readConfig(home);
    assert.deepEqual(after, { mcpServers: { fortmesa: { command: SPEC.command, args: [] } } });
  });
});

test('project() reports action "error" (never throws) on unparseable JSON', async () => {
  await withTempHome(async (home) => {
    const path = configPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not valid json', 'utf-8');

    const result = await project(SPEC, true);
    assert.equal(result.action, 'error');
    assert.equal(result.restartNote, EXPECTED_RESTART_NOTE);
    assert.match(result.detail, /Failed to read\/parse/);
  });
});

test("project() passes spec.args through literally (no interpolation) and never mutates the caller's array", async () => {
  await withTempHome(async (home) => {
    await writeConfig(home, await loadFixture());
    const spec = { command: SPEC.command, args: ['--env', 'sandbox'] };

    const result = await project(spec, true);
    assert.equal(result.action, 'added');

    const after = await readConfig(home);
    assert.deepEqual(after.mcpServers.fortmesa.args, ['--env', 'sandbox']);
  });
});
