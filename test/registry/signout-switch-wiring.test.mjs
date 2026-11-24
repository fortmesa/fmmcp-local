// FMDEV-879: Sign out and Switch environment are reachable while signed out or
// expired. Asserted against the source text and the manifest (same approach as
// custom-servers-wiring.test.mjs): the subject is which commands exist and
// which buttons the expired box carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFile(join(repoRoot, p), 'utf-8');

test('the manifest contributes Sign out and Switch environment commands', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const commands = manifest.contributes.commands.map((c) => c.command);
  assert.ok(commands.includes('fortmesa.signOut'), 'fortmesa.signOut');
  assert.ok(commands.includes('fortmesa.switchEnvironment'), 'fortmesa.switchEnvironment');
});

test('the extension registers both commands', async () => {
  const src = await read('src/extension/session-commands.ts');
  assert.match(src, /registerCommand\(\s*'fortmesa\.signOut'/);
  assert.match(src, /registerCommand\(\s*'fortmesa\.switchEnvironment'/);
});

test('the expired box in the Signed-in user view renders the alternatives', async () => {
  const src = await read('src/extension/identity-view.ts');
  assert.match(src, /id="expiredAlternatives"/);
  assert.match(src, /type: 'switchEnvironment'/);
});

test('Switch environment does not depend on being signed in (no auth read before the pick)', async () => {
  const src = await read('src/extension/session-commands.ts');
  const body = src.slice(src.indexOf("'fortmesa.switchEnvironment'"));
  const handler = body.slice(
    0,
    body.indexOf('registerCommand', 10) === -1 ? undefined : body.indexOf('registerCommand', 10),
  );
  assert.doesNotMatch(handler, /readCredentials|resolveCredentials|getAccessToken/);
});
