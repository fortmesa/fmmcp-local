// Items 1, 2 and 5 (PO, 2026-09-05) — the Resources view's labels/icons and
// the Signed-in user view-title action icon.
//
// Asserted against the BUILT extension output plus package.json (the manifest
// IS the icon's source of truth for a view/title action). Same
// read-the-built-artifact pattern as test/registry/prod-warning.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const treeView = async () => readFile(new URL('../../dist/extension/tree-view.js', import.meta.url), 'utf-8');
const manifest = async () => JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf-8'));

test('item 1: the Resources row is labelled "FortMesa App", not "Open FortMesa"', async () => {
  const src = await treeView();
  assert.match(src, /label: 'FortMesa App'/);
  assert.equal(/label: 'Open FortMesa'/.test(src), false, 'the old label must be gone');
});

test('item 1: the command title in the manifest matches the row label', async () => {
  const pkg = await manifest();
  const command = pkg.contributes.commands.find((c) => c.command === 'fortmesa.openApp');
  assert.equal(command.title, 'FortMesa App');
});

// PO: "icons for these three resources extra links are confusing, one is
// semantic and 2 are external link .. they should either be all three
// semantic or all three external link". external-link for all three: every
// one of them leaves the IDE for a browser, which is the fact worth
// signalling before the click.
test('item 2: all three web rows carry link-external, and none carries the old semantic icon', async () => {
  const src = await treeView();
  const rows = ['saferoom.openApp', 'saferoom.partnerPortal', 'saferoom.knowledge'];
  for (const id of rows) {
    const i = src.indexOf(`id: '${id}'`);
    assert.ok(i > -1, `${id} row must exist`);
    const block = src.slice(i, i + 400);
    assert.match(block, /ThemeIcon\('link-external'\)/, `${id} must use link-external`);
  }
  assert.equal(/ThemeIcon\('book'\)/.test(src), false, 'the semantic "book" icon must be gone');
});

test('item 2: "Settings" keeps settings-gear — it opens a webview INSIDE the IDE and is not one of the three', async () => {
  const src = await treeView();
  const i = src.indexOf("id: 'saferoom.openSettings'");
  assert.match(src.slice(i, i + 400), /ThemeIcon\('settings-gear'\)/);
});

// PO: "the signed in user icon on the view expansion at top right looks like
// it might be sign in or sign out ... a person with a plus sign, or just the
// default plus". `person-add` chosen over `add`: the codicon `sign-in` glyph
// is an arrow-into-door that is a near mirror image of `sign-out`, which is
// the whole confusion; `person-add` has no such twin AND still says WHAT is
// being added, which a bare `add` does not.
test('item 5: the Signed-in user view-title action uses person-add, not sign-in', async () => {
  const pkg = await manifest();
  const login = pkg.contributes.commands.find((c) => c.command === 'fortmesa.login');
  assert.equal(login.icon, '$(person-add)');
  assert.notEqual(login.icon, '$(sign-in)');
});

test('item 5: that action is still the one on the identity view, and its tooltip says what it does', async () => {
  const pkg = await manifest();
  const entry = pkg.contributes.menus['view/title'].find(
    (m) => m.command === 'fortmesa.login' && m.when === 'view == fortmesa.identity',
  );
  assert.ok(entry, 'fortmesa.login must still be the identity view-title action');
  // VS Code renders a view/title action's tooltip from the command title.
  const login = pkg.contributes.commands.find((c) => c.command === 'fortmesa.login');
  assert.equal(login.title, 'Sign In');
});
