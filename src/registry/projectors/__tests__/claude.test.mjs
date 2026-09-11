// Fixture/unit tests for src/registry/projectors/claude.ts.
//
// Run against the BUILT output (same convention as scripts/test-runner.mjs,
// scripts/hot-reload-test.mjs, and the sibling projector tests under test/,
// which all drive the compiled dist/ output rather than TS sources
// directly): `yarn build && yarn node src/registry/projectors/__tests__/claude.test.mjs`.
//
// This directory is deliberately excluded from both the tsc project and the
// ESLint targets (see tsconfig.json's plain-.mjs-is-never-compiled behavior
// and eslint.config.mjs's ignore entry for this path) — a plain node:test
// script, not part of the shipped dist/ output.
//
// Forces the file-fallback merge path deterministically by clearing `PATH`
// (claude.ts's `isClaudeCliOnPath` probes PATH directories directly, so an
// empty PATH guarantees no `claude` executable is ever found) regardless of
// whether the real `claude` CLI happens to be installed on the machine
// running this suite. The real `claude` CLI (and the developer's real
// ~/.claude.json) is never touched by this suite — `CLAUDE_HOME_DIR` redirects
// every read/write to an isolated temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, project } from '../../../../dist/registry/projectors/claude.js';

const SPEC = { command: '/workspaces/fmmcp-local/launch-mcp.sh', args: [] };

/**
 * Run `fn` with `CLAUDE_HOME_DIR` pointed at a fresh temp dir and `PATH`
 * cleared, so every test deterministically exercises the `~/.claude.json`
 * file-fallback path (never the `claude` CLI path) regardless of whether
 * some other tool happens to be on this machine's real PATH. Cleans up the
 * temp dir and restores both env vars afterward even if `fn` throws.
 */
async function withIsolatedClaudeHome(fn) {
  const tmpHome = await mkdtemp(join(tmpdir(), 'fortmesa-claude-projector-test-'));
  const prevHome = process.env.CLAUDE_HOME_DIR;
  const prevPath = process.env.PATH;

  process.env.CLAUDE_HOME_DIR = tmpHome;
  process.env.PATH = ''; // guarantee no real `claude` executable is found

  try {
    await fn(join(tmpHome, '.claude.json'));
  } finally {
    if (prevHome === undefined) {
      delete process.env.CLAUDE_HOME_DIR;
    } else {
      process.env.CLAUDE_HOME_DIR = prevHome;
    }
    process.env.PATH = prevPath;
    await rm(tmpHome, { recursive: true, force: true });
  }
}

test('claude projector: file-fallback merge preserves foreign state and manages only mcpServers.fortmesa', async (t) => {
  await withIsolatedClaudeHome(async (claudeJsonPath) => {
    const fixture = {
      someOtherKey: { nested: true },
      oauthAccount: { id: 'unrelated-session-state' },
      mcpServers: {
        otherServer: { type: 'stdio', command: 'x', args: [], env: {} },
      },
    };
    await writeFile(claudeJsonPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');

    await t.test(
      'project(spec, true) adds fortmesa and preserves the foreign top-level key + sibling server',
      async () => {
        const result = await project(SPEC, true);

        assert.equal(result.target, 'claude');
        assert.equal(result.action, 'added');
        assert.equal(result.restartNote, 'restart your Claude Code session to pick up this change');

        const after = JSON.parse(await readFile(claudeJsonPath, 'utf-8'));

        // Foreign top-level keys survive by value, untouched.
        assert.deepEqual(after.someOtherKey, { nested: true });
        assert.deepEqual(after.oauthAccount, { id: 'unrelated-session-state' });

        // Sibling mcpServers entry survives by value, untouched.
        assert.deepEqual(after.mcpServers.otherServer, { type: 'stdio', command: 'x', args: [], env: {} });

        // Our own entry has the right shape.
        assert.deepEqual(after.mcpServers.fortmesa, {
          type: 'stdio',
          command: SPEC.command,
          args: [],
          env: {},
        });

        // Nothing else got added at either level.
        assert.deepEqual(Object.keys(after).sort(), ['mcpServers', 'oauthAccount', 'someOtherKey']);
        assert.deepEqual(Object.keys(after.mcpServers).sort(), ['fortmesa', 'otherServer']);
      },
    );

    await t.test('project(spec, true) again reports unchanged and does not rewrite the file', async () => {
      const before = await readFile(claudeJsonPath, 'utf-8');
      const result = await project(SPEC, true);
      const after = await readFile(claudeJsonPath, 'utf-8');

      assert.equal(result.action, 'unchanged');
      assert.equal(before, after);
    });

    await t.test('project(spec, false) removes only mcpServers.fortmesa, preserving everything else', async () => {
      const result = await project(SPEC, false);

      assert.equal(result.target, 'claude');
      assert.equal(result.action, 'updated');

      const after = JSON.parse(await readFile(claudeJsonPath, 'utf-8'));

      assert.deepEqual(after.someOtherKey, { nested: true });
      assert.deepEqual(after.oauthAccount, { id: 'unrelated-session-state' });
      assert.deepEqual(after.mcpServers.otherServer, { type: 'stdio', command: 'x', args: [], env: {} });
      assert.equal(Object.prototype.hasOwnProperty.call(after.mcpServers, 'fortmesa'), false);
    });

    await t.test('project(spec, false) again (nothing to remove) reports unchanged, not error', async () => {
      const result = await project(SPEC, false);
      assert.equal(result.action, 'unchanged');
    });
  });
});

test('claude projector: detect() is false with no CLI and no ~/.claude.json, true once the file exists', async () => {
  await withIsolatedClaudeHome(async () => {
    assert.equal(await detect(), false);
  });

  await withIsolatedClaudeHome(async (claudeJsonPath) => {
    await writeFile(claudeJsonPath, '{}\n', 'utf-8');
    assert.equal(await detect(), true);
  });
});

test('claude projector: fresh machine (no ~/.claude.json yet) — project(spec, true) creates the file with only fortmesa', async () => {
  await withIsolatedClaudeHome(async (claudeJsonPath) => {
    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const after = JSON.parse(await readFile(claudeJsonPath, 'utf-8'));
    assert.deepEqual(Object.keys(after), ['mcpServers']);
    assert.deepEqual(after.mcpServers.fortmesa, { type: 'stdio', command: SPEC.command, args: [], env: {} });
  });
});

test('claude projector: fresh machine — project(spec, false) is a no-op skip, no file created', async () => {
  await withIsolatedClaudeHome(async (claudeJsonPath) => {
    const result = await project(SPEC, false);
    assert.equal(result.action, 'skipped');

    await assert.rejects(readFile(claudeJsonPath, 'utf-8'));
  });
});

test('claude projector: an unparseable ~/.claude.json is treated as empty, not a crash', async () => {
  await withIsolatedClaudeHome(async (claudeJsonPath) => {
    await writeFile(claudeJsonPath, '{ this is not valid json', 'utf-8');

    const result = await project(SPEC, true);
    assert.equal(result.action, 'added');

    const after = JSON.parse(await readFile(claudeJsonPath, 'utf-8'));
    assert.deepEqual(Object.keys(after), ['mcpServers']);
    assert.deepEqual(after.mcpServers.fortmesa, { type: 'stdio', command: SPEC.command, args: [], env: {} });
  });
});
