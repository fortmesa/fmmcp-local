// Round 4 wiring (PO, 2026-09-08). Three of the round's rulings are about
// what a surface DOES, not about a pure function's return value, so they are
// asserted against the built artifacts: the removal of the "Unlock all"
// sidebar action, the removal of the sign-out confirmation, and the table
// markup of the Accessible scopes panel.
//
// Source-text assertions are weak evidence in general — they cannot see
// behaviour. They are used HERE because each claim is about the absence or
// presence of a control, which is exactly what source text can settle, and
// because the alternative (an extension host) does not exist in this repo's
// test rig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (rel) => readFile(new URL(rel, import.meta.url), 'utf-8');
const manifest = async () => JSON.parse(await read('../../package.json'));

test('the "Unlock all" action is gone from the manifest — command AND menu', async () => {
  const pkg = await manifest();
  const commands = pkg.contributes.commands.map((entry) => entry.command);
  assert.equal(commands.includes('fortmesa.unlockScope'), false, 'the command contribution must be gone');
  const menu = pkg.contributes.menus['view/title'].map((entry) => entry.command);
  assert.equal(menu.includes('fortmesa.unlockScope'), false, 'the view-title menu entry must be gone');
});

test('nothing registers or invokes fortmesa.unlockScope any more', async () => {
  const src = await read('../../dist/extension/switchers.js');
  assert.equal(/registerCommand\(\s*'fortmesa\.unlockScope'/.test(src), false);
  assert.equal(src.includes('handleUnlockScope'), false);
});

test('mode "unlocked" is still a fully rendered config state — removal of the button is not removal of the state', async () => {
  const { scopeRowPresentation } = await import('../../dist/registry/scope-display.js');
  const row = scopeRowPresentation('unlocked', [], 'anything');
  assert.equal(row.state, 'unlocked');
  assert.equal(row.description, 'accessible');
});

test('no user-facing scope string says "locked" any more', async () => {
  const { scopeRowPresentation } = await import('../../dist/registry/scope-display.js');
  for (const [mode, scopes] of [
    ['unlocked', []],
    ['single', ['alpha']],
    ['multi', ['beta']],
  ]) {
    const row = scopeRowPresentation(mode, scopes, 'alpha');
    assert.doesNotMatch(row.description, /lock/i, `description for ${mode} still says "lock"`);
    assert.doesNotMatch(row.tooltip, /lock/i, `tooltip for ${mode} still says "lock"`);
  }
});

test('the sign-out confirmation strip is gone; one click acts', async () => {
  const src = await read('../../dist/extension/identity-view.js');
  for (const gone of ['signOutConfirm', 'signOutConfirmYes', 'signOutCancel', 'you would need the original token']) {
    assert.equal(src.includes(gone), false, `identity-view still contains "${gone}"`);
  }
  assert.match(src, /id="signOut"/, 'the button itself must survive');
  assert.match(src, /clearAction\.label/, 'its label must come from the host, by credential kind');
});

test('the Accessible scopes panel renders a table with a headline bulk control', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  for (const present of [
    'id="bulk"',
    'id="selectAll"',
    'id="clear"',
    'id="filter"',
    '<thead>',
    'indeterminate',
    'shiftKey',
  ]) {
    assert.ok(src.includes(present), `scope-select-panel is missing "${present}"`);
  }
  assert.equal(src.includes('scope(s) locked'), false, 'the inverted count string must be gone');
});

// SUPERSEDED BY ROUND 5 (PO, same day, after testing 0.7.4: "we need to avoid
// the apply button which may be scrolled offscreen … I think we should
// auto-apply"). Round 4 asserted `id="apply"` / `id="cancel"` here and that the
// webview adopted the host draft via `message.payload.draft.slice()`. Both
// controls are gone and the draft is now adopted inside `render()` from
// `state.draft` (mode + scopes, not a bare array). The surviving half of each
// claim — that the panel never rebuilds the draft from the FILTERED rows — is
// asserted below and in `vsix-round5-wiring.test.mjs`.
test('the panel adopts the host draft wholesale, never rebuilding it from the filtered rows', async () => {
  const src = await read('../../dist/extension/scope-select-panel.js');
  assert.match(src, /draft = \{ mode: state\.draft\.mode, scopes: state\.draft\.scopes\.slice\(\) \}/);
  assert.equal(/draft = view\.rows/.test(src), false, 'the filtered rows must never be the source of the draft');
});
