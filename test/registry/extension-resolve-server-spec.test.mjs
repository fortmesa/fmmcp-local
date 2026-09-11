// Unit tests for the pure, vscode-free `resolveServerSpec` export of
// src/extension/extension.ts (UX-ROUND-2-PLAN.md W1 / T020): the extension's
// proxy-launch command must resolve under the extension's OWN install path,
// never the open workspace folder.
//
// Regression context: the extension's own auto-sync previously wrote a
// `fortmesa` entry pointing at `<workspaceFolders[0]>/launch-mcp.sh`. In this
// pod, `workspaceFolders[0]` resolves to `/workspaces` (the multi-repo
// parent, not the `fmmcp-local` checkout), so the projected command pointed
// at a file that does not exist — the ONLY reason tools worked at all was a
// separate, correctly-pathed `fortmesa-sandbox` entry from earlier manual
// wiring, unrelated to anything the extension itself produced.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/extension-resolve-server-spec.test.mjs`.
//
// Reuses the `vscode` stub loader (see extension-ide-sync-changed.test.mjs's
// header for why this is needed — extension.ts has a top-level `import *
// as vscode from 'vscode'` even though `resolveServerSpec` never touches
// `vscode.*`).

import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./vscode-stub-loader.mjs', import.meta.url);

const { resolveServerSpec } = await import('../../dist/extension/extension.js');

/** The actual repo checkout root (this test file lives at <repoRoot>/test/registry/). */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('resolveServerSpec: resolves launch-mcp.sh under the given extension path', () => {
  const spec = resolveServerSpec(repoRoot);
  assert.equal(spec.command, join(repoRoot, 'launch-mcp.sh'));
  assert.deepEqual(spec.args, []);
});

test('resolveServerSpec: the resolved command actually exists on disk (extension install path == this checkout in dev)', () => {
  const spec = resolveServerSpec(repoRoot);
  assert.ok(existsSync(spec.command), `expected ${spec.command} to exist`);
});

test('T020 regression: the old workspace-parent bug path has no launch-mcp.sh, and resolveServerSpec never routes through it', () => {
  const buggyWorkspaceParent = '/workspaces';
  assert.ok(
    !existsSync(join(buggyWorkspaceParent, 'launch-mcp.sh')),
    'sanity: the previously-observed bug path truly has no launch-mcp.sh',
  );
  // resolveServerSpec takes only an extension path — there is no workspace
  // folder parameter left to accidentally route through it.
  const spec = resolveServerSpec(repoRoot);
  assert.notEqual(spec.command, join(buggyWorkspaceParent, 'launch-mcp.sh'));
});
