import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GitHub Copilot projector — user-level `mcp.json`.
 *
 * The two things that make this projector different from its siblings are
 * exactly what these tests pin: the map key is `servers` (NOT `mcpServers`),
 * and unrelated content in the file survives a projection untouched.
 *
 * `COPILOT_USER_DIR` redirects the target directory, mirroring the sibling
 * projectors' `CURSOR_HOME_DIR`/`CODEX_HOME_DIR` test seams.
 */

const SPEC = { command: '/repo/launch-mcp.sh', args: ['--env', 'next'] };

async function withTempUserDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-proj-'));
  const previous = process.env.COPILOT_USER_DIR;
  process.env.COPILOT_USER_DIR = dir;
  try {
    // Fresh module per case: the projector reads the env var at call time,
    // but re-importing keeps each case independent of module state.
    const mod = await import(`../../../dist/registry/projectors/copilot.js?case=${encodeURIComponent(dir)}`);
    return await fn(mod, dir, join(dir, 'mcp.json'));
  } finally {
    if (previous === undefined) delete process.env.COPILOT_USER_DIR;
    else process.env.COPILOT_USER_DIR = previous;
  }
}

test('copilot: writes the entry under "servers", not "mcpServers"', async () => {
  await withTempUserDir(async (mod, _dir, path) => {
    const result = await mod.project(SPEC, true);
    assert.equal(result.action, 'added');

    const root = JSON.parse(await readFile(path, 'utf-8'));
    assert.deepEqual(root.servers.fortmesa, { command: SPEC.command, args: SPEC.args });
    // VS Code ignores `mcpServers` entirely — writing it would silently register nothing.
    assert.equal('mcpServers' in root, false);
  });
});

test('copilot: preserves unrelated top-level keys and other servers', async () => {
  await withTempUserDir(async (mod, dir, path) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ inputs: [{ id: 'token' }], servers: { other: { command: 'keep', args: ['me'] } } }, null, 2),
    );

    await mod.project(SPEC, true);

    const root = JSON.parse(await readFile(path, 'utf-8'));
    assert.deepEqual(root.inputs, [{ id: 'token' }]);
    assert.deepEqual(root.servers.other, { command: 'keep', args: ['me'] });
    assert.equal(root.servers.fortmesa.command, SPEC.command);
  });
});

test('copilot: a second identical projection reports unchanged and rewrites nothing', async () => {
  await withTempUserDir(async (mod, _dir, path) => {
    await mod.project(SPEC, true);
    const first = await readFile(path, 'utf-8');

    const result = await mod.project(SPEC, true);
    assert.equal(result.action, 'unchanged');
    assert.equal(await readFile(path, 'utf-8'), first);
  });
});

test('copilot: disabling removes only our entry, leaving the rest intact', async () => {
  await withTempUserDir(async (mod, dir, path) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({ servers: { other: { command: 'keep', args: [] } } }, null, 2));
    await mod.project(SPEC, true);

    const result = await mod.project(SPEC, false);
    assert.equal(result.action, 'updated');

    const root = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal('fortmesa' in root.servers, false);
    assert.deepEqual(root.servers.other, { command: 'keep', args: [] });
  });
});

test('copilot: disabling with no file present is skipped, and creates nothing', async () => {
  await withTempUserDir(async (mod, dir, path) => {
    // Point at a subdirectory that does not exist, so neither file nor dir is present.
    process.env.COPILOT_USER_DIR = join(dir, 'absent');
    const absent = join(dir, 'absent', 'mcp.json');

    const result = await mod.project(SPEC, false);
    assert.equal(result.action, 'skipped');
    await assert.rejects(() => readFile(absent, 'utf-8'));
  });
});

test('copilot: detect() is true once the user directory exists', async () => {
  await withTempUserDir(async (mod, dir) => {
    await mkdir(dir, { recursive: true });
    assert.equal(await mod.detect(), true);

    process.env.COPILOT_USER_DIR = join(dir, 'absent');
    assert.equal(await mod.detect(), false);
  });
});
