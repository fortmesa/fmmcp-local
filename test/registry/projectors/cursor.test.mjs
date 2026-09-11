// Fixture/unit tests for src/registry/projectors/cursor.ts.
//
// Run against the BUILT output (same convention as scripts/test-runner.mjs,
// scripts/hot-reload-test.mjs, and the sibling projector tests, which drive
// compiled dist/ rather than TS sources directly):
// `yarn build && yarn node test/registry/projectors/cursor.test.mjs`.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.
//
// Unlike the codex/claude/antigravity projectors, cursor.ts is FILE-ONLY —
// there is no CLI to shell out to and therefore no PATH-clearing needed here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, project } from '../../../dist/registry/projectors/cursor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
const GOOD_FIXTURE = join(REPO_ROOT, 'test/fixtures/ide-configs/cursor-mcp-config.json');
const MALFORMED_FIXTURE = join(REPO_ROOT, 'test/fixtures/ide-configs/cursor-mcp-malformed.json');

const SPEC = { command: '/workspaces/fmmcp-local/launch-mcp.sh', args: [] };

/**
 * Run `fn` with `CURSOR_HOME_DIR` pointed at a fresh temp dir, so every test
 * deterministically operates on an isolated fixture instead of this
 * machine's real `~/.cursor/mcp.json`. Cleans up and restores the env var
 * afterward even if `fn` throws.
 */
async function withIsolatedCursorHome(fn) {
  const tmpHome = await mkdtemp(join(tmpdir(), 'fortmesa-cursor-projector-test-'));
  const prevHome = process.env.CURSOR_HOME_DIR;

  process.env.CURSOR_HOME_DIR = tmpHome;

  try {
    await fn(tmpHome);
  } finally {
    if (prevHome === undefined) {
      delete process.env.CURSOR_HOME_DIR;
    } else {
      process.env.CURSOR_HOME_DIR = prevHome;
    }
    await rm(tmpHome, { recursive: true, force: true });
  }
}

test('cursor projector: surgical merge preserves foreign state and manages only mcpServers.fortmesa', async (t) => {
  await withIsolatedCursorHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'mcp.json');
    await cp(GOOD_FIXTURE, configPath);

    await t.test('project(spec, true) adds fortmesa and preserves the unrelated key + sibling servers', async () => {
      const result = await project(SPEC, true);

      assert.equal(result.target, 'cursor');
      assert.equal(result.action, 'added');
      assert.equal(
        result.restartNote,
        "open Cursor's MCP settings panel and click Refresh (or restart Cursor) to pick up this change",
      );

      const written = JSON.parse(await readFile(configPath, 'utf-8'));

      // Foreign top-level key survives by value.
      assert.equal(written.__testUnrelatedTopLevelSetting, 'must-survive-untouched');

      // Sibling mcpServers entries survive byte-for-byte, including one that
      // uses Cursor's ${env:...} interpolation syntax — we must never touch it.
      assert.deepEqual(written.mcpServers.filesystem, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspaces'],
      });
      assert.deepEqual(written.mcpServers.github, {
        command: 'docker',
        args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'],
        env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
      });

      // Our own entry has the right shape — plain literals, no interpolation.
      assert.deepEqual(written.mcpServers.fortmesa, { command: SPEC.command, args: [] });
    });

    await t.test('project(spec, true) again reports unchanged and does not rewrite the file', async () => {
      const before = await readFile(configPath, 'utf-8');
      const result = await project(SPEC, true);
      const after = await readFile(configPath, 'utf-8');

      assert.equal(result.action, 'unchanged');
      assert.equal(before, after);
    });

    await t.test('project(spec, false) deletes only mcpServers.fortmesa, preserving everything else', async () => {
      const result = await project(SPEC, false);

      assert.equal(result.target, 'cursor');
      assert.equal(result.action, 'updated');

      const written = JSON.parse(await readFile(configPath, 'utf-8'));

      assert.equal(written.__testUnrelatedTopLevelSetting, 'must-survive-untouched');
      assert.deepEqual(written.mcpServers.filesystem, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspaces'],
      });
      assert.deepEqual(written.mcpServers.github, {
        command: 'docker',
        args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'],
        env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
      });

      assert.equal('fortmesa' in written.mcpServers, false);
    });

    await t.test('project(spec, false) again (nothing to remove) reports unchanged, not error', async () => {
      const result = await project(SPEC, false);
      assert.equal(result.action, 'unchanged');
    });
  });
});

test('cursor projector: detect() is false on a fresh machine, true once ~/.cursor exists', async () => {
  await withIsolatedCursorHome(async (tmpHome) => {
    // mkdtemp creates tmpHome itself; remove it to simulate "Cursor not installed"
    // (cursor.ts's detect() treats the home dir's mere existence as a signal).
    await rm(tmpHome, { recursive: true, force: true });
    assert.equal(await detect(), false);
  });

  await withIsolatedCursorHome(async () => {
    // mkdtemp already created the home dir itself and nothing else.
    assert.equal(await detect(), true);
  });

  await withIsolatedCursorHome(async (tmpHome) => {
    await cp(GOOD_FIXTURE, join(tmpHome, 'mcp.json'));
    assert.equal(await detect(), true);
  });
});

test('cursor projector: fresh machine (no mcp.json yet) — project(spec, true) creates the file with only fortmesa', async () => {
  await withIsolatedCursorHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'mcp.json');

    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(Object.keys(written), ['mcpServers']);
    assert.deepEqual(written.mcpServers.fortmesa, { command: SPEC.command, args: [] });
  });
});

test('cursor projector: fresh machine — project(spec, false) is a no-op skip, no file created', async () => {
  await withIsolatedCursorHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'mcp.json');

    const result = await project(SPEC, false);
    assert.equal(result.action, 'skipped');

    await assert.rejects(readFile(configPath, 'utf-8'));
  });
});

test('cursor projector: an unparseable mcp.json is treated as empty, not a crash', async () => {
  await withIsolatedCursorHome(async (tmpHome) => {
    const configPath = join(tmpHome, 'mcp.json');
    await cp(MALFORMED_FIXTURE, configPath);

    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(written.mcpServers.fortmesa, { command: SPEC.command, args: [] });
  });
});
