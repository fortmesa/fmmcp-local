// Documents tools mode — Local-file vs Network (PO, 2026-09-10; VSIX 0.7.9).
//
// The three `grc_documents_*` names are implemented on BOTH sides of the
// proxy (local path-based file I/O vs the gateway's URL-based presigned
// links). Before this feature the local trio won unconditionally and no
// setting could reach the gateway's. These tests pin the three things that
// make the switch real rather than cosmetic:
//
//   1. the projector the Settings panel renders (both modes, and that the
//      row DESCRIPTIONS differ — a switch that changes nothing visible is
//      exactly the "not clearly reflected" complaint that started this),
//   2. the EXPOSURE SET per mode — the same `mergeToolLists` the proxy's
//      tools/list handler calls, plus the `dispatchesLocally` rule its
//      tools/call handler routes by (the two must agree for every name, or
//      an agent validates against one schema and reaches the other),
//   3. PERSISTENCE in config.json, including that a pre-0.7.9 file with no
//      such field still loads and defaults to Local-file mode.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/documents-mode.test.mjs

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// settings-sync.ts has a top-level `import * as vscode` that PnP cannot
// resolve outside the extension host — same stub loader, and same reason, as
// test/registry/settings-sync.test.mjs. The functions used here are pure.
register('./vscode-stub-loader.mjs', import.meta.url);

const {
  DEFAULT_DOCUMENTS_MODE,
  DOCUMENTS_MODE_OPTIONS,
  DOCUMENTS_TOOL_NAMES,
  dispatchesLocally,
  documentsModeOption,
  documentsSectionView,
  documentsToolRows,
  isDocumentsMode,
  isDocumentsToolName,
  mergeToolLists,
  augmentGatewayTool,
} = await import('../../dist/registry/documents-mode.js');
const { loadConfig, saveConfig } = await import('../../dist/registry/config.js');
const { configFromSnapshot, snapshotFromConfig } = await import('../../dist/extension/settings-sync.js');

const DOC_NAMES = ['grc_documents_read', 'grc_documents_write', 'grc_documents_delete'];

async function withIsolatedFmcodeDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fortmesa-docsmode-test-'));
  const previous = process.env.FMCODE_DIR;
  process.env.FMCODE_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.FMCODE_DIR;
    else process.env.FMCODE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 1. projector ──────────────────────────────────────────────

test('the default is Local-file mode — the behaviour every release before 0.7.9 hard-coded', () => {
  assert.equal(DEFAULT_DOCUMENTS_MODE, 'local');
});

test('the three names are exactly the documents trio', () => {
  assert.deepEqual([...DOCUMENTS_TOOL_NAMES], DOC_NAMES);
  for (const name of DOC_NAMES) assert.equal(isDocumentsToolName(name), true);
  assert.equal(isDocumentsToolName('grc_controls_read'), false);
  assert.equal(isDocumentsToolName('grc_documents'), false);
});

test('both options are offered, in display order, sentence case, each with a preamble', () => {
  assert.deepEqual(
    DOCUMENTS_MODE_OPTIONS.map((o) => o.id),
    ['local', 'network'],
  );
  assert.deepEqual(
    DOCUMENTS_MODE_OPTIONS.map((o) => o.label),
    ['Local-file mode', 'Network mode'],
  );
  for (const option of DOCUMENTS_MODE_OPTIONS) {
    assert.ok(option.preamble.length > 80, `${option.id} needs a real paragraph, not a phrase`);
  }
});

test('local mode projects the local-file preamble and workspace-path row descriptions', () => {
  const view = documentsSectionView('local');
  assert.equal(view.mode, 'local');
  assert.equal(view.preamble, documentsModeOption('local').preamble);
  assert.match(view.preamble, /in your workspace/);
  assert.deepEqual(
    view.rows.map((r) => r.name),
    DOC_NAMES,
  );
  assert.match(view.rows[0].description, /workspace/);
});

test('network mode projects the signed-link preamble and URL-based row descriptions', () => {
  const view = documentsSectionView('network');
  assert.equal(view.mode, 'network');
  assert.match(view.preamble, /signed upload and download links/);
  assert.match(view.preamble, /no local file access/i);
  assert.deepEqual(
    view.rows.map((r) => r.name),
    DOC_NAMES,
  );
  assert.match(view.rows[0].description, /signed download URL/);
});

test('the two modes describe the SAME three names DIFFERENTLY — the point of the split table', () => {
  const local = documentsToolRows('local');
  const network = documentsToolRows('network');
  for (let i = 0; i < DOC_NAMES.length; i += 1) {
    assert.equal(local[i].name, network[i].name);
    assert.notEqual(local[i].description, network[i].description);
  }
});

test('isDocumentsMode rejects anything the webview might send that is not a mode', () => {
  assert.equal(isDocumentsMode('local'), true);
  assert.equal(isDocumentsMode('network'), true);
  for (const bad of ['Local', 'LOCAL-FILE', '', undefined, null, 0, {}]) {
    assert.equal(isDocumentsMode(bad), false);
  }
});

// ── 2. exposure set per mode ──────────────────────────────────

const GATEWAY_TOOLS = [
  { name: 'grc_scopes', side: 'gateway' },
  { name: 'grc_documents_read', side: 'gateway' },
  { name: 'grc_documents_write', side: 'gateway' },
  { name: 'grc_documents_delete', side: 'gateway' },
  { name: 'grc_controls_read', side: 'gateway' },
];
const LOCAL_TOOLS = [
  { name: 'grc_documents_read', side: 'local' },
  { name: 'grc_documents_write', side: 'local' },
  { name: 'grc_documents_delete', side: 'local' },
];

const sideOf = (tools, name) => tools.find((t) => t.name === name)?.side;

test('local mode: the GATEWAY trio is advertised, widened - the local copy never wins', () => {
  // This inverted on the relay refactor. Local mode used to SHADOW the gateway
  // tools with the ones compiled into the VSIX, which froze their schema on
  // the day that VSIX shipped. The user installs the VSIX and rarely updates
  // it, so a document type the gateway adds has to reach an old install. The
  // gateway's tool is now what gets advertised; this process only widens it.
  const exposed = mergeToolLists(GATEWAY_TOOLS, LOCAL_TOOLS, 'local', new Set());
  for (const name of DOC_NAMES) {
    assert.equal(exposed.filter((t) => t.name === name).length, 1, `${name} must appear exactly once`);
    assert.equal(sideOf(exposed, name), 'gateway', `${name}: the stale local copy must not be advertised`);
  }
  // Non-documents gateway tools are untouched in either mode.
  assert.equal(sideOf(exposed, 'grc_scopes'), 'gateway');
  assert.equal(sideOf(exposed, 'grc_controls_read'), 'gateway');
});

test('network mode: the GATEWAY trio passes through and the local trio is withheld', () => {
  const exposed = mergeToolLists(GATEWAY_TOOLS, LOCAL_TOOLS, 'network', new Set());
  for (const name of DOC_NAMES) {
    assert.equal(exposed.filter((t) => t.name === name).length, 1, `${name} must appear exactly once`);
    assert.equal(sideOf(exposed, name), 'gateway');
  }
  assert.equal(sideOf(exposed, 'grc_scopes'), 'gateway');
});

test('neither mode ever advertises a name twice, and neither drops a name entirely', () => {
  for (const mode of ['local', 'network']) {
    const names = mergeToolLists(GATEWAY_TOOLS, LOCAL_TOOLS, mode, new Set()).map((t) => t.name);
    assert.deepEqual([...new Set(names)].sort(), [...names].sort(), `${mode}: duplicate tool name advertised`);
    for (const name of DOC_NAMES) assert.ok(names.includes(name), `${mode}: ${name} disappeared`);
  }
});

test('the per-tool disable checkbox still wins, in BOTH modes', () => {
  for (const mode of ['local', 'network']) {
    const names = mergeToolLists(GATEWAY_TOOLS, LOCAL_TOOLS, mode, new Set(['grc_documents_delete'])).map(
      (t) => t.name,
    );
    assert.equal(names.includes('grc_documents_delete'), false, `${mode}: a disabled tool must stay hidden`);
    assert.ok(names.includes('grc_documents_read'), `${mode}: only the unchecked tool is hidden`);
  }
});

test('the documents trio dispatches locally in local mode and relays in network mode', () => {
  // Advertised object and dispatch target deliberately diverge in local mode:
  // the schema comes from the gateway, the handler runs here. That is what
  // lets this process add `download`/`upload` without owning the rest.
  const registryHas = (name) => DOC_NAMES.includes(name);
  for (const name of DOC_NAMES) {
    assert.equal(dispatchesLocally(name, 'local', registryHas(name)), true, `local/${name} must run here`);
    assert.equal(dispatchesLocally(name, 'network', registryHas(name)), false, `network/${name} must relay`);
  }
});

test('a tool this process has no handler for never dispatches locally', () => {
  for (const mode of ['local', 'network']) {
    assert.equal(dispatchesLocally('grc_scopes', mode, false), false, mode);
    assert.equal(dispatchesLocally('grc_controls_read', mode, false), false, mode);
  }
});

// ── 3. persistence ────────────────────────────────────────────

test('documentsMode persists to config.json and reads back', async () => {
  await withIsolatedFmcodeDir(async (dir) => {
    const initial = await loadConfig();
    assert.equal(initial.documentsMode, 'local', 'a fresh config must default to Local-file mode');

    await saveConfig({ ...initial, documentsMode: 'network' });
    assert.equal((await loadConfig()).documentsMode, 'network');

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8'));
    assert.equal(onDisk.documentsMode, 'network', 'the mode must live in the same store as the tool checkboxes');

    await saveConfig({ ...initial, documentsMode: 'local' });
    assert.equal((await loadConfig()).documentsMode, 'local');
  });
});

test('a pre-0.7.9 config.json with no documentsMode still loads, defaulting to Local-file mode', async () => {
  await withIsolatedFmcodeDir(async (dir) => {
    const legacy = {
      version: 1,
      activeEnv: 'prod',
      scopeLock: { mode: 'unlocked', scopes: [] },
      environments: { prod: { gateway: 'https://mcp.fortmesa.com/mcp' } },
      ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
      logLevel: 'info',
      disabledTools: [],
    };
    await writeFile(join(dir, 'config.json'), JSON.stringify(legacy), 'utf-8');
    assert.equal((await loadConfig()).documentsMode, 'local');
  });
});

test('an unrecognised documentsMode makes the file INVALID rather than silently guessing', async () => {
  await withIsolatedFmcodeDir(async (dir) => {
    const config = await loadConfig();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ ...config, documentsMode: 'cloudy' }), 'utf-8');
    await assert.rejects(loadConfig(), /documentsMode/);
  });
});

test('the VS Code settings mirror carries documentsMode in both directions', () => {
  const config = {
    version: 1,
    activeEnv: 'prod',
    scopeLock: { mode: 'unlocked', scopes: [] },
    environments: { prod: { gateway: 'https://mcp.fortmesa.com/mcp' } },
    ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
    logLevel: 'info',
    disabledTools: [],
    documentsMode: 'network',
  };
  assert.equal(snapshotFromConfig(config).documentsMode, 'network');
  assert.equal(configFromSnapshot(snapshotFromConfig(config)).documentsMode, 'network');
});

// -- 4. augmentGatewayTool: the gateway's schema, widened by exactly two methods --
//
// The VSIX is installed by a user and then rarely updated, so anything it
// hardcodes freezes on the day it shipped. Inheriting the gateway's schema
// live is what lets a document type added next month reach an install from
// last year; this process only adds the two methods that need a filesystem.

const gatewayRead = {
  name: 'grc_documents_read',
  description: 'Read document operations.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['list', 'get', 'download_url', 'generate'] },
      scopeId: { type: 'string' },
      documentType: { type: 'string', enum: ['securityGapDoc', 'assetInventoryReport-device'] },
    },
    required: ['method', 'scopeId'],
  },
};

const methodEnum = (tool) => tool.inputSchema?.properties?.method?.enum ?? [];

test('augmentGatewayTool: the gateway description survives and the added method is explained', () => {
  const out = augmentGatewayTool(gatewayRead);
  assert.ok(out.description.startsWith('Read document operations.'));
  assert.match(out.description, /download/);
});

test('augmentGatewayTool: documentType is inherited live, so a new type reaches an old VSIX', () => {
  const out = augmentGatewayTool(gatewayRead);
  assert.deepEqual(out.inputSchema.properties.documentType.enum, ['securityGapDoc', 'assetInventoryReport-device']);
});

test('augmentGatewayTool: only the filesystem method and filePath are added', () => {
  const out = augmentGatewayTool(gatewayRead);
  assert.deepEqual(methodEnum(out), ['list', 'get', 'download_url', 'generate', 'download']);
  assert.ok(out.inputSchema.properties.filePath !== undefined, 'download needs somewhere to write');
  assert.ok(out.inputSchema.properties.scopeId !== undefined, 'existing properties are preserved');
});

test('augmentGatewayTool: the write tool gains upload, not download', () => {
  assert.deepEqual(methodEnum(augmentGatewayTool({ ...gatewayRead, name: 'grc_documents_write' })).slice(-1), [
    'upload',
  ]);
});

test('augmentGatewayTool: a tool this process does not extend is returned untouched', () => {
  const scopes = { name: 'grc_scopes', description: 'Scopes.', inputSchema: { type: 'object', properties: {} } };
  assert.equal(augmentGatewayTool(scopes), scopes);
  // grc_documents_delete is relayed outright: nothing local to add.
  const del = { ...gatewayRead, name: 'grc_documents_delete' };
  assert.deepEqual(methodEnum(augmentGatewayTool(del)), methodEnum(del));
});

test('augmentGatewayTool: a gateway tool with no usable schema is passed through, not mangled', () => {
  // A gateway that changes its schema shape must degrade to a plain relay
  // rather than produce a tool whose inputSchema this process invented.
  for (const odd of [
    { name: 'grc_documents_read', description: 'x' },
    { name: 'grc_documents_read', description: 'x', inputSchema: null },
    { name: 'grc_documents_read', description: 'x', inputSchema: { type: 'object' } },
  ]) {
    assert.equal(augmentGatewayTool(odd), odd, JSON.stringify(odd));
  }
});

test('augmentGatewayTool: augmenting twice does not duplicate the added method', () => {
  const twice = methodEnum(augmentGatewayTool(augmentGatewayTool(gatewayRead)));
  assert.deepEqual(
    twice.filter((m) => m === 'download'),
    ['download'],
  );
});

test('mergeToolLists: local mode advertises the gateway schema widened, never the stale local copy', () => {
  const stale = {
    name: 'grc_documents_read',
    description: 'STALE COPY compiled into the VSIX',
    inputSchema: { type: 'object', properties: { method: { enum: ['list', 'download'] } } },
  };
  const merged = mergeToolLists([gatewayRead], [stale], 'local', new Set());
  const doc = merged.find((t) => t.name === 'grc_documents_read');
  assert.ok(!JSON.stringify(doc).includes('STALE COPY'), 'the hardcoded copy must not win');
  assert.deepEqual(methodEnum(doc), ['list', 'get', 'download_url', 'generate', 'download']);
});

test('mergeToolLists: network mode is a pure relay, with nothing widened', () => {
  const merged = mergeToolLists([gatewayRead], [], 'network', new Set());
  assert.deepEqual(methodEnum(merged[0]), ['list', 'get', 'download_url', 'generate']);
});

test('mergeToolLists: a local tool with no gateway counterpart is still advertised', () => {
  const merged = mergeToolLists([gatewayRead], [{ name: 'some_local_only_tool' }], 'local', new Set());
  assert.ok(merged.some((t) => t.name === 'some_local_only_tool'));
});

test('augmentGatewayTool: a method property with no enum is relayed untouched, not given an invented one', () => {
  // Widening an absent enum would produce `enum: ['download']` - advertising
  // the added method as the ONLY legal value and hiding list/get/generate.
  const noEnum = {
    name: 'grc_documents_read',
    description: 'Read document operations.',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, scopeId: { type: 'string' } } },
  };
  assert.equal(augmentGatewayTool(noEnum), noEnum);
});
