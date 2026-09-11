// Unit tests for the pure, vscode-free `ideSyncChanged` export of
// src/extension/extension.ts (R3 · REVISION-PLAN.md): the field-by-field
// `ideSync.*` diff that gates the sync-on-activation /
// sync-on-ideSync-change behavior (plan amendment A1 — NOT on every config
// change).
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/extension-ide-sync-changed.test.mjs`.
//
// --- Why this file registers a `vscode` stub loader -----------------------
//
// extension.ts has a top-level `import * as vscode from 'vscode'`, even
// though `ideSyncChanged` itself is pure and never touches `vscode.*`.
// Under plain `yarn node --test` (Yarn PnP), `vscode` is not a real
// resolvable runtime package (only `@types/vscode`, types-only, is
// installed — the real `vscode` module is injected by the VS Code extension
// host at run time), so importing `dist/extension/extension.js` directly
// would throw before `ideSyncChanged` could even be reached. This reuses
// the exact same `node:module` customization hook
// (`vscode-stub-loader.mjs`, colocated in this directory) that
// `settings-sync.test.mjs` already established for the identical problem —
// no new mocking mechanism, no source changes.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./vscode-stub-loader.mjs', import.meta.url);

const { ideSyncChanged } = await import('../../dist/extension/extension.js');

/** A representative, fully-populated ideSync object (registry/config.ts's shape). */
function sampleIdeSync(overrides = {}) {
  return { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true, ...overrides };
}

test('ideSyncChanged: previous undefined (activation) always counts as changed', () => {
  assert.equal(ideSyncChanged(undefined, sampleIdeSync()), true);
});

test('ideSyncChanged: identical ideSync objects are not changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync();
  assert.equal(ideSyncChanged(a, b), false);
});

test('ideSyncChanged: a different claude flag counts as changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync({ claude: false });
  assert.equal(ideSyncChanged(a, b), true);
});

test('ideSyncChanged: a different vscode flag counts as changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync({ vscode: false });
  assert.equal(ideSyncChanged(a, b), true);
});

test('ideSyncChanged: a different cursor flag counts as changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync({ cursor: false });
  assert.equal(ideSyncChanged(a, b), true);
});

test('ideSyncChanged: a different codex flag counts as changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync({ codex: false });
  assert.equal(ideSyncChanged(a, b), true);
});

test('ideSyncChanged: a different antigravity flag counts as changed', () => {
  const a = sampleIdeSync();
  const b = sampleIdeSync({ antigravity: false });
  assert.equal(ideSyncChanged(a, b), true);
});

test('ideSyncChanged: unrelated env/scope changes are irrelevant — only ideSync fields are compared (same object passed twice)', () => {
  // ideSyncChanged only ever receives the ideSync sub-object (see
  // extension.ts's applyConfig), so an env/scope switch that leaves
  // ideSync untouched never reaches this function with a "changed" verdict
  // — this test documents that the function's contract is scoped to
  // ideSync.* only, by construction of its parameter type.
  const a = sampleIdeSync();
  const b = sampleIdeSync();
  assert.equal(ideSyncChanged(a, b), false);
});
