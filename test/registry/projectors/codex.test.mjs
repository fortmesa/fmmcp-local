// Fixture/unit tests for src/registry/projectors/codex.ts.
//
// Run against the BUILT output (same convention as scripts/test-runner.mjs
// and scripts/hot-reload-test.mjs, which drive the compiled dist/ CLI rather
// than TS sources directly): `yarn build && yarn node test/registry/projectors/codex.test.mjs`.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.
//
// Must run via `yarn node` (not plain `node`) so Yarn's PnP resolver can find
// `smol-toml`, exactly like the existing E2E scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { detect, project } from '../../../dist/registry/projectors/codex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
const GOOD_FIXTURE = join(REPO_ROOT, 'test/fixtures/ide-configs/codex-mcp-config.toml');
const MALFORMED_FIXTURE = join(REPO_ROOT, 'test/fixtures/ide-configs/codex-mcp-malformed.toml');

const SPEC = { command: '/workspaces/fmmcp-local/launch-mcp.sh', args: [] };

/**
 * Run `fn` with `CODEX_HOME_DIR` pointed at a fresh temp dir and `PATH`
 * cleared, so every test deterministically exercises the TOML file-fallback
 * path (never the `codex` CLI path) regardless of whether some other tool
 * happens to be on this machine's real PATH. Cleans up the temp dir and
 * restores both env vars afterward even if `fn` throws.
 */
async function withIsolatedCodexHome(fn) {
  const tmpHome = await mkdtemp(join(tmpdir(), 'fortmesa-codex-projector-test-'));
  const prevHome = process.env.CODEX_HOME_DIR;
  const prevPath = process.env.PATH;

  process.env.CODEX_HOME_DIR = tmpHome;
  process.env.PATH = ''; // guarantee no real `codex` executable is found

  try {
    await fn(tmpHome);
  } finally {
    if (prevHome === undefined) {
      delete process.env.CODEX_HOME_DIR;
    } else {
      process.env.CODEX_HOME_DIR = prevHome;
    }
    process.env.PATH = prevPath;
    await rm(tmpHome, { recursive: true, force: true });
  }
}

test('codex projector: file-fallback merge preserves foreign state and manages only mcp_servers.fortmesa', async (t) => {
  await withIsolatedCodexHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'config.toml');
    await cp(GOOD_FIXTURE, configPath);

    await t.test(
      'project(spec, true) adds/updates fortmesa and preserves the unrelated table + sibling server',
      async () => {
        const result = await project(SPEC, true);

        assert.equal(result.target, 'codex');
        assert.equal(result.action, 'added');
        assert.equal(result.restartNote, 'restart your next Codex CLI/IDE invocation to pick up this change');

        const written = parse(await readFile(configPath, 'utf-8'));

        // Foreign top-level scalar survives by value.
        assert.equal(written.__testUnrelatedTopLevelSetting, 'must-survive-untouched');

        // Foreign top-level table survives by value.
        assert.deepEqual(written.some_other_tool, { enabled: true, note: 'leave me alone' });

        // Sibling mcp_servers entry survives by value, untouched.
        assert.deepEqual(written.mcp_servers.unrelated_server, {
          command: '/usr/local/bin/other-mcp-server',
          args: ['--flag', 'value'],
          enabled: true,
        });

        // Our own entry has the right shape.
        assert.deepEqual(written.mcp_servers.fortmesa, {
          command: SPEC.command,
          args: [],
          enabled: true,
        });
      },
    );

    await t.test('project(spec, true) again reports unchanged and does not rewrite the file', async () => {
      const before = await readFile(configPath, 'utf-8');
      const result = await project(SPEC, true);
      const after = await readFile(configPath, 'utf-8');

      assert.equal(result.action, 'unchanged');
      assert.equal(before, after);
    });

    await t.test('project(spec, false) deletes only mcp_servers.fortmesa, preserving everything else', async () => {
      const result = await project(SPEC, false);

      assert.equal(result.target, 'codex');
      assert.equal(result.action, 'updated');

      const written = parse(await readFile(configPath, 'utf-8'));

      assert.equal(written.__testUnrelatedTopLevelSetting, 'must-survive-untouched');
      assert.deepEqual(written.some_other_tool, { enabled: true, note: 'leave me alone' });
      assert.deepEqual(written.mcp_servers.unrelated_server, {
        command: '/usr/local/bin/other-mcp-server',
        args: ['--flag', 'value'],
        enabled: true,
      });

      assert.equal('fortmesa' in written.mcp_servers, false);
    });

    await t.test('project(spec, false) again (nothing to remove) reports unchanged, not error', async () => {
      const result = await project(SPEC, false);
      assert.equal(result.action, 'unchanged');
    });
  });
});

test('codex projector: detect() is false with no CLI and no config file, true once a config file exists', async () => {
  await withIsolatedCodexHome(async () => {
    assert.equal(await detect(), false);
  });

  await withIsolatedCodexHome(async (tmpHome) => {
    await cp(GOOD_FIXTURE, join(tmpHome, 'config.toml'));
    assert.equal(await detect(), true);
  });
});

test('codex projector: fresh machine (no config.toml yet) — project(spec, true) creates the file with only fortmesa', async () => {
  await withIsolatedCodexHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'config.toml');

    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const written = parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(Object.keys(written), ['mcp_servers']);
    assert.deepEqual(written.mcp_servers.fortmesa, { command: SPEC.command, args: [], enabled: true });
  });
});

test('codex projector: fresh machine — project(spec, false) is a no-op skip, no file created', async () => {
  await withIsolatedCodexHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'config.toml');

    const result = await project(SPEC, false);
    assert.equal(result.action, 'skipped');

    await assert.rejects(readFile(configPath, 'utf-8'));
  });
});

test('codex projector: an unparseable config.toml is treated as empty, not a crash', async () => {
  await withIsolatedCodexHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'config.toml');
    await cp(MALFORMED_FIXTURE, configPath);

    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const written = parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(written.mcp_servers.fortmesa, { command: SPEC.command, args: [], enabled: true });
  });
});
