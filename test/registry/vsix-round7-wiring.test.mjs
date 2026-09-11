// Wiring tests for VSIX ROUND 7 (0.7.9), PO 2026-09-10:
//
//   (A) the Signed-in user card: no Identity provider / Token ID rows, no
//       doubled "expires expires", and a zone-stamped absolute Expires;
//   (B) Settings > Tools: the documents tools split into a SECOND table with
//       a mode switch, and — the part that makes it more than cosmetic — the
//       proxy routing by that mode at both of its decision points.
//
// These read the BUILT output, the same convention as
// advanced-token-placement.test.mjs, because the webview markup and the
// handler are string literals inside `vscode`-importing modules that a plain
// node:test run cannot instantiate. Behaviour that CAN be exercised directly
// lives in documents-mode.test.mjs (exposure sets, routing, persistence) —
// this file exists to prove those decisions are actually WIRED to the panes.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/vsix-round7-wiring.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf-8');
const identity = () => read('../../dist/extension/identity-view.js');
const settings = () => read('../../dist/extension/saferoom-settings.js');
const proxy = () => read('../../dist/local-mcp/proxy.js');
const cli = () => read('../../dist/local-mcp/cli.js');

// ── (A) Signed-in user card ───────────────────────────────────

test('the card no longer builds Identity provider or Token ID ROWS', async () => {
  const src = await identity();
  assert.equal(
    src.includes("label: 'Identity provider'"),
    false,
    'the Identity provider row is still built into the card details',
  );
  assert.equal(src.includes("label: 'Token ID'"), false, 'the Token ID row is still built into the card details');
});

test('the card still builds Data region and Expires', async () => {
  const src = await identity();
  assert.match(src, /label: 'Data region'/);
  assert.match(src, /label: 'Expires', value: formatExactExpiry/);
});

test('the removed facts survive as a headline hover, not as rows', async () => {
  const src = await identity();
  assert.match(src, /Identity provider: \$\{provider\}/);
  assert.match(src, /Token ID: \$\{sub\}/);
  assert.match(src, /\$\('primary'\)\.title = state\.hoverDetail/);
});

test('the doubled word is gone: the view no longer prefixes "expires" onto a string that starts with it', async () => {
  const src = await identity();
  assert.equal(
    /\\u00b7 expires ' \+ state\.relativeExpiry/.test(src),
    false,
    'identity-view still concatenates "expires" in front of formatRelativeExpiry\'s own "expires in ..."',
  );
  assert.match(src, /\\u00b7 ' \+ state\.relativeExpiry/);
});

test('the Settings > Identity table KEEPS the two facts the card dropped', async () => {
  const src = await settings();
  assert.match(src, /label: 'Identity provider'/);
  assert.match(src, /label: 'Token ID'/);
});

// ── (B) Settings > Tools: the Documents table ─────────────────

test('Tools renders a SECOND table titled Documents, with its own tbody', async () => {
  const src = await settings();
  assert.match(src, /<h3 class="subhead">Documents<\/h3>/);
  assert.match(src, /<table id="documentsTable">/);
  assert.match(src, /id="documentsTools"/);
  assert.match(src, /<tbody id="tools"><\/tbody>/, 'the general Tools table must still exist alongside it');
});

test('the switch is a labelled two-option radiogroup, and the preamble sits ABOVE the table', async () => {
  const src = await settings();
  assert.match(src, /id="documentsMode" role="radiogroup"/);
  assert.match(src, /id="documentsPreamble"/);
  const preambleAt = src.indexOf('id="documentsPreamble"');
  const tableAt = src.indexOf('<table id="documentsTable">');
  assert.ok(preambleAt > 0 && tableAt > preambleAt, 'the preamble must precede the Documents table');
});

test('the panel renders the host-decided options, preamble and rows — it invents no copy of its own', async () => {
  const src = await settings();
  assert.match(src, /documentsSectionView\(config\.documentsMode\)/);
  assert.match(src, /state\.documents\.options/);
  assert.match(src, /documentsPreamble'\)\.textContent = state\.documents\.preamble/);
  assert.match(src, /state\.documents\.rows/);
});

test('moving the switch persists to the SAME store as the tool checkboxes', async () => {
  const src = await settings();
  assert.match(src, /type: 'setDocumentsMode'/, 'the webview must post the change to the host');
  assert.match(src, /case 'setDocumentsMode'/, 'the host must handle it');
  assert.match(src, /saveConfig\(\{ \.\.\.config, documentsMode: message\.mode \}\)/);
  assert.match(src, /isDocumentsMode\(message\.mode\)/, 'an untrusted webview value must be validated');
});

test('the three documents tools are NOT duplicated into the general Tools table', async () => {
  const src = await settings();
  assert.match(src, /withoutDocumentsTools\(gatewayTools\)/);
  assert.equal(
    src.includes("{ name: 'grc_documents_read', description: 'Read/list documents"),
    false,
    'the old LOCAL_DOCUMENT_TOOLS display list should be gone — rows now come from documents-mode.ts',
  );
});

// ── (B) the switch DRIVES behaviour ───────────────────────────

test('the proxy decides tools/list and tools/call by the shared mode rules', async () => {
  const src = await proxy();
  assert.match(src, /mergeToolLists\(upstream\.tools, registry\.listDefs\(\), documentsMode, disabledTools\)/);
  assert.match(src, /dispatchesLocally\(name, documentsMode, registry\.has\(name\)\)/);
  assert.equal(
    /const localNames = new Set\(local\.map/.test(src),
    false,
    'the old hard-coded shadow filter must be gone, or the mode can be bypassed',
  );
});

test('the live mode is reassigned on reload, like the lock and the disabled set', async () => {
  const src = await proxy();
  assert.match(src, /documentsMode = next\.documentsMode/);
  assert.match(src, /getDocumentsMode: \(\) => documentsMode/);
});

test('a mode change reaches a CONNECTED agent: reload sends tools/list_changed', async () => {
  const src = await proxy();
  const reloadAt = src.indexOf('documentsMode = next.documentsMode');
  const notifyAt = src.indexOf('sendToolListChanged');
  assert.ok(reloadAt > 0 && notifyAt > reloadAt, 'the tools-changed notification must follow the mode swap');
});

test('the CLI feeds the configured mode in at startup AND on every config change', async () => {
  const src = await cli();
  assert.match(src, /documentsMode: loadedConfig\.documentsMode/);
  assert.match(src, /documentsMode: newConfig\.documentsMode/);
});
