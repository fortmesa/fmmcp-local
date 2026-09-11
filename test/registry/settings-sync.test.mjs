// Unit tests for the pure, vscode-free exports of
// src/extension/settings-sync.ts (R7 · REVISION-PLAN.md): snapshotFromConfig,
// configFromSnapshot, configEquals, diffSettingsUpdates.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/settings-sync.test.mjs`.
//
// --- Why this file registers a `vscode` stub loader -----------------------
//
// settings-sync.ts has a top-level `import * as vscode from 'vscode'`, even
// though the four functions under test here are pure and never touch
// `vscode.*` at call time (see that module's own doc comment: "deliberately
// free of vscode imports" applies to their *logic*, not the module's
// load-time import graph). Under plain `yarn node --test` (Yarn PnP),
// `vscode` is not a real resolvable runtime package — only `@types/vscode`
// (types-only) is installed; the real `vscode` module is injected by the VS
// Code extension host at run time. Importing `dist/extension/settings-sync.js`
// directly therefore throws before any exported function can be reached:
//
//   Error: Your application tried to access vscode, but it isn't declared
//   in your dependencies...
//
// There is no existing shim for this anywhere in the repo (confirmed by
// grepping for vscode mocks — the only precedent is esbuild's
// `--external:vscode` for the real packaged extension, which doesn't help a
// plain `node --test` run). Rather than modifying settings-sync.ts (out of
// scope for this test-only slice, and owned by a different work item) or
// blocking this whole suite, this file registers a small, standard
// `node:module` customization hook (`vscode-stub-loader.mjs`, colocated in
// this directory) that intercepts ONLY the bare specifier `vscode` and
// serves a trivial empty module — enough to satisfy the `import * as vscode`
// statement without ever being dereferenced by the functions under test.
// This is a documented, zero-side-effect resolution of a genuine tension
// between "test these vscode-free functions" and "do it with zero vscode
// mocking" — flagged here and in the implementation report per instruction.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

register('./vscode-stub-loader.mjs', import.meta.url);

const { snapshotFromConfig, configFromSnapshot, configEquals, diffSettingsUpdates } =
  await import('../../dist/extension/settings-sync.js');

/** A representative, fully-populated Config (registry/config.ts's shape). */
function sampleConfig(overrides = {}) {
  return {
    version: 1,
    activeEnv: 'sandbox',
    scopeLock: { mode: 'multi', scopes: ['scope-a', 'scope-b'] },
    environments: {
      sandbox: { gateway: 'http://localhost:3020/mcp' },
      next: { gateway: 'https://mcp-next.dev.fort.blue/mcp' },
      prod: { gateway: 'https://mcp.fortmesa.com/mcp' },
    },
    ideSync: { claude: true, vscode: true, cursor: false, codex: true, antigravity: false, copilot: false },
    logLevel: 'debug',
    disabledTools: ['grc_vulnerabilities_write'],
    documentsMode: 'network',
    ...overrides,
  };
}

// --- snapshotFromConfig <-> configFromSnapshot round-trip -----------------

test('snapshotFromConfig -> configFromSnapshot: round-trips a representative Config unchanged', () => {
  const original = sampleConfig();
  const snapshot = snapshotFromConfig(original);
  const rebuilt = configFromSnapshot(snapshot);

  assert.deepEqual(rebuilt, original);
});

// --- Schema-coverage guard (REVISION-PLAN.md R8, Tier-3 lossiness item) ---
//
// configFromSnapshot rebuilds a WHOLE Config from FortmesaSettingsSnapshot's
// ~10 fields (see that function's doc comment) — correct today because the
// snapshot's fields exactly cover configSchema's top-level keys, but silently
// lossy if configSchema ever grows a field that nobody remembers to also add
// to FortmesaSettingsSnapshot/snapshotFromConfig/configFromSnapshot/
// configEquals/diffSettingsUpdates (see D011 item 6 in .agent/DECISIONS.md).
// Rather than trusting a human to keep the two lists in sync by eye, this
// test reads src/registry/config.ts's *source* (there is no runtime-
// introspectable export of the zod schema, and adding one is out of this
// slice's scope) and extracts configSchema's actual top-level key list via a
// narrow, literal regex against its `z.object({ ... })` block — so it fails
// loudly the next time someone adds a field there without touching this
// suite, rather than staying silently green.
test('schema-coverage guard: every top-level configSchema key in config.ts has a FortmesaSettingsSnapshot field', async () => {
  const configTsPath = fileURLToPath(new URL('../../src/registry/config.ts', import.meta.url));
  const configTsSource = await readFile(configTsPath, 'utf8');

  const schemaBlockMatch = /const configSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(configTsSource);
  assert.ok(
    schemaBlockMatch,
    'could not locate `const configSchema = z.object({ ... });` in src/registry/config.ts — ' +
      'has it been renamed or reshaped? Update this test’s regex to match.',
  );

  const schemaKeys = [...schemaBlockMatch[1].matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map((m) => m[1]).sort();

  // The top-level Config keys FortmesaSettingsSnapshot/snapshotFromConfig/
  // configFromSnapshot collectively know how to carry. `version` is
  // deliberately excluded: configFromSnapshot hardcodes `version: 1` (the
  // only value the schema currently allows) rather than round-tripping it,
  // documented in that function's own doc comment.
  const snapshotCoveredKeys = [
    'activeEnv',
    'disabledTools',
    'documentsMode',
    'environments',
    'ideSync',
    'logLevel',
    'scopeLock',
  ].sort();
  const knownExemptKeys = ['version'];

  const uncoveredKeys = schemaKeys.filter(
    (key) => !snapshotCoveredKeys.includes(key) && !knownExemptKeys.includes(key),
  );

  assert.deepEqual(
    uncoveredKeys,
    [],
    `config.ts's configSchema grew a new top-level key (${uncoveredKeys.join(', ')}) that ` +
      'FortmesaSettingsSnapshot does not carry — configFromSnapshot will silently drop it on ' +
      'every settings-sync round-trip. Add it to FortmesaSettingsSnapshot, snapshotFromConfig, ' +
      'configFromSnapshot, configEquals, AND diffSettingsUpdates together (settings-sync.ts), ' +
      'then extend this test’s snapshotCoveredKeys list.',
  );
});

// --- configEquals -----------------------------------------------------------

test('configEquals: two snapshots built from the same Config are equal', () => {
  const config = sampleConfig();
  const a = snapshotFromConfig(config);
  const b = snapshotFromConfig(config);

  assert.equal(configEquals(a, b), true);
});

test('configEquals: changing activeEnv makes snapshots unequal', () => {
  const a = snapshotFromConfig(sampleConfig());
  const b = snapshotFromConfig(sampleConfig({ activeEnv: 'next' }));

  assert.equal(configEquals(a, b), false);
});

test('configEquals: changing one ideSync.* boolean makes snapshots unequal', () => {
  const a = snapshotFromConfig(sampleConfig());
  const b = snapshotFromConfig(
    sampleConfig({
      ideSync: { claude: true, vscode: true, cursor: false, codex: true, antigravity: true, copilot: true },
    }),
  );

  assert.equal(configEquals(a, b), false);
});

test('configEquals: changing scopeLockScopes (via scopeLock.scopes) makes snapshots unequal', () => {
  const a = snapshotFromConfig(sampleConfig());
  const b = snapshotFromConfig(sampleConfig({ scopeLock: { mode: 'multi', scopes: ['scope-a', 'scope-c'] } }));

  assert.equal(configEquals(a, b), false);
});

// --- diffSettingsUpdates ------------------------------------------------------

test('diffSettingsUpdates: two identical snapshots return an empty array', () => {
  const snapshot = snapshotFromConfig(sampleConfig());
  const updates = diffSettingsUpdates(snapshot, snapshot);

  assert.deepEqual(updates, []);
});

test('diffSettingsUpdates: returns exactly the keys for fields that differ (single field: activeEnv)', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(sampleConfig({ activeEnv: 'next' }));

  const updates = diffSettingsUpdates(current, desired);

  assert.deepEqual(
    updates.map((u) => u.key),
    ['activeEnv'],
  );
  assert.equal(updates[0].value, 'next');
});

test('diffSettingsUpdates: returns exactly N keys when N fields differ (activeEnv, scopeLock.mode, ideSync.vscode)', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(
    sampleConfig({
      activeEnv: 'prod',
      scopeLock: { mode: 'unlocked', scopes: [] },
      ideSync: { claude: true, vscode: false, cursor: false, codex: true, antigravity: false, copilot: false },
    }),
  );

  const updates = diffSettingsUpdates(current, desired);
  const keys = updates.map((u) => u.key).sort();

  // scopeLock.mode AND scopeLock.scopes both changed (mode + emptied scopes),
  // so this differs in 4 dotted keys, not 3 — enumerate precisely rather
  // than assuming.
  assert.deepEqual(keys, ['activeEnv', 'ideSync.vscode', 'scopeLock.mode', 'scopeLock.scopes']);
});

test('diffSettingsUpdates: exactly one key per changed ideSync target, using the documented dotted key strings', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(
    sampleConfig({
      ideSync: { claude: false, vscode: true, cursor: false, codex: false, antigravity: true, copilot: true },
    }),
  );

  const updates = diffSettingsUpdates(current, desired);
  const keys = updates.map((u) => u.key).sort();

  // current: claude:true, vscode:true, cursor:false, codex:true, antigravity:false, copilot:false
  // desired: claude:false, vscode:true, cursor:false, codex:false, antigravity:true, copilot:true
  // -> claude and codex flip false, antigravity and copilot flip true; vscode/cursor unchanged.
  assert.deepEqual(keys, ['ideSync.antigravity', 'ideSync.claude', 'ideSync.codex', 'ideSync.copilot']);
});

test('diffSettingsUpdates: environments diff is keyed "environments" and carries the full desired environments object', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(
    sampleConfig({
      environments: {
        sandbox: { gateway: 'http://localhost:3020/mcp' },
        next: { gateway: 'https://mcp-next.dev.fort.blue/mcp' },
        prod: { gateway: 'https://mcp.fortmesa.com/mcp' },
        alt: { gateway: 'http://localhost:3099/mcp' },
      },
    }),
  );

  const updates = diffSettingsUpdates(current, desired);

  assert.deepEqual(
    updates.map((u) => u.key),
    ['environments'],
  );
  assert.deepEqual(updates[0].value, desired.environments);
});

// --- Loop-termination property (module doc comment, turned into a test) ---

/**
 * Apply a `diffSettingsUpdates` result onto a plain-object copy of a
 * snapshot's underlying fields, using the exact dotted keys the function
 * emits, producing a new snapshot object.
 */
function applyUpdates(snapshot, updates) {
  const next = { ...snapshot };
  for (const update of updates) {
    switch (update.key) {
      case 'activeEnv':
        next.activeEnv = update.value;
        break;
      case 'environments':
        next.environments = update.value;
        break;
      case 'scopeLock.mode':
        next.scopeLockMode = update.value;
        break;
      case 'scopeLock.scopes':
        next.scopeLockScopes = update.value;
        break;
      case 'ideSync.claude':
        next.ideSyncClaude = update.value;
        break;
      case 'ideSync.vscode':
        next.ideSyncVscode = update.value;
        break;
      case 'ideSync.cursor':
        next.ideSyncCursor = update.value;
        break;
      case 'ideSync.codex':
        next.ideSyncCodex = update.value;
        break;
      case 'ideSync.antigravity':
        next.ideSyncAntigravity = update.value;
        break;
      case 'logLevel':
        next.logLevel = update.value;
        break;
      case 'disabledTools':
        next.disabledTools = update.value;
        break;
      default:
        throw new Error(`applyUpdates: unrecognized diffSettingsUpdates key "${update.key}"`);
    }
  }
  return next;
}

test('loop-termination property: after applying diffSettingsUpdates(current, desired) to current, the reverse diff against desired is empty', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(
    sampleConfig({
      activeEnv: 'next',
      scopeLock: { mode: 'unlocked', scopes: [] },
      ideSync: { claude: false, vscode: true, cursor: true, codex: false, antigravity: false, copilot: false },
      logLevel: 'error',
    }),
  );

  // Sanity: they do actually differ going in.
  assert.equal(configEquals(current, desired), false);

  const forwardUpdates = diffSettingsUpdates(current, desired);
  assert.ok(forwardUpdates.length > 0, 'expected at least one field to differ');

  const currentAfter = applyUpdates(current, forwardUpdates);

  // current-after should now equal desired on every field this predicate covers.
  assert.equal(configEquals(currentAfter, desired), true);

  // And the reverse diff (desired -> current-after) must be empty — no
  // infinite ping-pong once one direction's write has landed.
  const reverseUpdates = diffSettingsUpdates(desired, currentAfter);
  assert.deepEqual(reverseUpdates, []);
});

test('loop-termination property: holds even for a single-field change', () => {
  const current = snapshotFromConfig(sampleConfig());
  const desired = snapshotFromConfig(sampleConfig({ logLevel: 'warn' }));

  const forwardUpdates = diffSettingsUpdates(current, desired);
  assert.deepEqual(
    forwardUpdates.map((u) => u.key),
    ['logLevel'],
  );

  const currentAfter = applyUpdates(current, forwardUpdates);
  const reverseUpdates = diffSettingsUpdates(desired, currentAfter);
  assert.deepEqual(reverseUpdates, []);
});
