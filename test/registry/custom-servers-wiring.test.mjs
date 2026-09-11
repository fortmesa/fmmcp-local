// The Data region control must render the SAME set of environments the rest of
// the panel uses.
//
// The defect this guards shipped for months. buildState built its environment
// list from ENVIRONMENTS, the compiled-in constant, while tokenEnvironments
// twenty lines later built its list from config.environments. Same panel, two
// sources. An environment added to config.json appeared in the token dropdown
// and not in the Data region dropdown, and since the Data region control is
// what writes activeEnv, it could not be selected at all.
//
// Asserted against the source text, same approach as security-delta.test.mjs:
// the subject is which expression feeds the view, and the function is not
// exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settingsPath = join(repoRoot, 'src/extension/saferoom-settings.ts');

test('the Data region list is built from the merged server list, not from ENVIRONMENTS', async () => {
  const src = await readFile(settingsPath, 'utf-8');
  assert.match(src, /environments: await Promise\.all\(\s*\n\s*mergeServerList\(config\.environments\)/);
  assert.equal(
    /environments: await Promise\.all\(\s*\n\s*Object\.entries\(ENVIRONMENTS\)/.test(src),
    false,
    'building the list from ENVIRONMENTS alone hides every server the user added',
  );
});

test('the panel handles adding and removing a server', async () => {
  const src = await readFile(settingsPath, 'utf-8');
  for (const kind of ['addServer', 'removeServer']) {
    assert.match(src, new RegExp(`case '${kind}':`), `${kind} must be handled by the host`);
    assert.match(src, new RegExp(`type: '${kind}'`), `${kind} must be sent by the webview`);
    assert.match(src, new RegExp(`readonly type: '${kind}'`), `${kind} must be in the InboundMessage union`);
  }
});

test('add and remove go through the config helpers rather than writing config.json inline', async () => {
  // Inline writes are how the two-source drift happened in the first place.
  // normalizeCustomServer owns name collisions, URL validation and the custom
  // marker; a second copy of those rules in the panel would drift from the CLI.
  const src = await readFile(settingsPath, 'utf-8');
  assert.match(src, /addCustomServer\(/);
  assert.match(src, /removeCustomServer\(/);
});

test('a failure to add is shown to the user, not just logged', async () => {
  // Every rejection from normalizeCustomServer is a message someone has to act
  // on: a duplicate name, an http:// gateway, a collision with a built-in.
  const src = await readFile(settingsPath, 'utf-8');
  const addBlock = src.slice(src.indexOf("case 'addServer':"), src.indexOf("case 'removeServer':"));
  assert.match(addBlock, /showErrorMessage/, 'the add path must surface its error');
  assert.match(addBlock, /catch/, 'and must not let it escape the handler');
});

test('only a user-added, non-active server offers a remove control', async () => {
  // Removing a built-in is meaningless, and removing the active one leaves
  // activeEnv pointing at nothing, which throws on the next startup.
  const src = await readFile(settingsPath, 'utf-8');
  assert.match(src, /env\.custom && env\.name !== state\.activeEnv/);
});
