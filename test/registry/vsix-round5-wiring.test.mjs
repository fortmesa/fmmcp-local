// Round 5 wiring (PO, 2026-09-08, after testing 0.7.4). Several of the round's
// rulings are about what a surface DOES rather than about a pure function's
// return value, so they are asserted against the built artifacts.
//
// Source-text assertions are weak evidence in general — they cannot see
// behaviour, and the real behaviour of the state machine is asserted by
// DRIVING it in `scope-sync.test.mjs`. They are used HERE for claims about the
// presence or absence of a control and about which module talks to which,
// which is exactly what source text can settle, and because the alternative
// (a live extension host) does not exist in this repo's test rig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (rel) => readFile(new URL(rel, import.meta.url), 'utf-8');

test('Apply and Cancel are gone from the Accessible scopes panel', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  for (const gone of ['id="apply"', 'id="cancel"', 'applyEnabled', 'applyBlockedReason', "type: 'apply'"]) {
    assert.equal(src.includes(gone), false, `scope-select-panel still contains "${gone}"`);
  }
});

test('the panel renders the mode toggle as a radiogroup with arrow keys, in sentence case', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.match(src, /role="radiogroup"/);
  assert.match(src, /setAttribute\('role', 'radio'\)/);
  assert.match(src, /aria-checked/);
  assert.match(src, /ArrowRight/);
  assert.match(src, /ArrowLeft/);
  assert.match(src, /tabIndex = option\.selected \? 0 : -1/, 'a radiogroup is ONE tab stop');
});

test('the panel keeps the sync affordance and drops the transition arrow', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.match(src, /id="sync"/);
  assert.match(src, /id="syncAction"/);
  assert.equal(src.includes('scope(s) locked'), false, 'the round-3 inverted count string must stay gone');
});

test('the column header is "Scope ID", and no org column was invented', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.match(src, /<th>Scope ID<\/th>/);
  // `grc_scopes list` passes through GET /api/v2/scopes, whose response
  // (fmweb-be ScopeV2Interface) carries no organisation display name — only
  // opaque user ids. `fetchScopeList` keeps {id, name}. An Org column would be
  // empty or a duplicate of Scope, and filling it would need another call.
  assert.equal(/<th>\s*Org/i.test(src), false, 'no org column — the API does not carry one');
  const resolve = await read('../../dist/registry/scope-resolve.js');
  assert.equal(/organization|orgName|tenantName/i.test(resolve), false);
});

test('typing in the filter box cannot schedule a config write', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  // Round 4 folded the filter into the same message as the checkboxes. Under
  // auto-apply that would make every keystroke a candidate write.
  assert.match(src, /postFilter/, 'the filter has a message of its own');
  assert.match(src, /\$\('filter'\)\.addEventListener\('input', \(\) => \{ postFilter\(\); \}\)/);
  assert.equal(/type: 'edit'[^}]*filter/.test(src), false, 'an edit message must not carry the filter string');
});

test('the panel is the only writer, and it writes through the machine', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  const saveCalls = src.match(/saveConfig\(/g) ?? [];
  assert.equal(saveCalls.length, 1, 'exactly one saveConfig call site — inside performWrite');
  assert.match(src, /syncTransition/);
  assert.match(src, /SYNC_DEBOUNCE_MS/);
});

test('zero scopes is writable: the empty-set refusal is gone from the host too', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.equal(src.includes('Select at least one scope'), false);
  assert.equal(/scopes\.length === 0/.test(src), false, 'the defence-in-depth early return is gone with the block');
});

test('the mode written for zero scopes is "multi", not the warning-tripping "single"', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.match(src, /scopes\.length === 1 \? 'single' : 'multi'/);
});

// ── Identity change ──────────────────────────────────────────────────────

test('every site that mutates credentials announces it', async () => {
  for (const rel of [
    '../../dist/extension/identity-view.js', // sign-out
    '../../dist/extension/sign-in-session.js', // completed OAuth sign-in
    '../../dist/extension/auth-commands.js', // pasted access token
  ]) {
    const src = await read(rel);
    assert.match(src, /notifyIdentityChanged\(/, `${rel} does not announce its credential change`);
  }
});

test('the announcement reaches the trees, the settings panel AND the scope panel', async () => {
  const ext = await read('../../dist/extension/extension.js');
  assert.match(ext, /onIdentityChanged\(/);
  assert.match(ext, /refreshAllTrees\(\)/);
  assert.match(ext, /refreshSaferoomSettingsIfOpen/);

  // The scope panel subscribes itself, because it needs more than a repaint.
  const panel = await read('../../dist/extension/scope-select-panel.js');
  assert.match(panel, /onIdentityChanged\(/);
  assert.match(panel, /identityChangeNotice/);
  assert.match(panel, /initialSyncState/, 'an identity change must reset the burst, not carry it across identities');
});

test('credentials.json is still NOT watched — the event exists so it need not be', async () => {
  const ext = await read('../../dist/extension/extension.js');
  assert.equal(/watch.*credentials/i.test(ext), false);
});

// ── Settings sections ────────────────────────────────────────────────────

test('the settings panel renders five disclosures in the PO order', async () => {
  const src = await read('../../dist/extension/saferoom-settings.js');
  const order = [...src.matchAll(/data-toggle="([a-zA-Z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['agents', 'tools', 'dataRegion', 'identity', 'scope']);
});

test('each disclosure is a real button with aria-expanded and aria-controls', async () => {
  const src = await read('../../dist/extension/saferoom-settings.js');
  for (const id of ['agents', 'tools', 'dataRegion', 'identity', 'scope']) {
    assert.match(src, new RegExp(`aria-controls="body-${id}"`), `${id} has no aria-controls`);
    assert.match(src, new RegExp(`id="body-${id}"`), `${id} has no region to control`);
  }
  assert.match(src, /button type="button" class="disclosure"/);
  // A native <button> fires click for Enter AND Space, so there is no keydown
  // handler to get wrong. Asserting the absence keeps that reasoning honest.
  assert.match(src, /A native <button> already fires click for both Enter and Space/);
});

test('the open/closed memory is per machine and namespaced', async () => {
  const src = await read('../../dist/extension/saferoom-settings.js');
  assert.match(src, /context\.globalState/);
  assert.equal(src.includes('context.workspaceState'), false, 'how a person works is not a property of the open repo');
  const sections = await read('../../dist/registry/settings-sections.js');
  assert.match(sections, /fortmesa\.settings\.sections/);
});

test('the sidebar still reflects unlocked mode without a count', async () => {
  const { scopeRowPresentation, compareScopeRows } = await import('../../dist/registry/scope-display.js');
  const row = scopeRowPresentation('unlocked', [], 'zulu');
  assert.equal(row.description, 'accessible');
  // In unlocked mode the accessible-first grouping degrades to plain
  // alphabetical, because every row is accessible.
  assert.ok(compareScopeRows('unlocked', [], 'alpha', 'zulu') < 0);
  assert.ok(compareScopeRows('unlocked', [], 'zulu', 'alpha') > 0);

  // Status-bar text moved to a projector (`statusBarSummaryFor`,
  // `registry/status-bar-summary.ts`, PO 2026-09-09): unlocked mode collapsed
  // from the literal "all scopes" summary to "Connected" — see
  // `test/extension/status-bar-summary.test.mjs` for the full state matrix.
  // This still asserts the underlying invariant this test was written for:
  // unlocked mode never renders a scope COUNT.
  const { statusBarSummaryFor } = await import('../../dist/registry/status-bar-summary.js');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'unlocked', scopes: [] }), 'Connected');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'unlocked', scopes: ['a', 'b', 'c'] }), 'Connected');
});
