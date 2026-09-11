// Item 1 (PO, 2026-09-05): "resources --> open FortMesa should go to fortmesa
// app at fortmesa.com/a/ and change the link to 'FortMesa App'".
//
// The regression this guards is the "hardcode prod" shortcut: the app lives
// under `/a/` on EVERY environment's own host, so the suffix must be derived
// per environment. A sandbox user sent to fortmesa.com/a/ would be looking at
// production.
//
// Run against the BUILT output (the convention every registry suite follows):
//   yarn build && yarn node --test test/registry/app-launch-url.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appLaunchUrl, accessTokenUrl, ENVIRONMENTS } from '../../dist/registry/environments.js';

test('appLaunchUrl: production resolves to fortmesa.com/a/ exactly as the PO specified', () => {
  assert.equal(appLaunchUrl('prod'), 'https://fortmesa.com/a/');
});

test('appLaunchUrl: every environment resolves to its OWN app host plus /a/ — never prod for all', () => {
  const seen = new Set();
  for (const [name, entry] of Object.entries(ENVIRONMENTS)) {
    const url = appLaunchUrl(name);
    assert.equal(url, `${entry.app.replace(/\/+$/, '')}/a/`, `${name} must use its own app host`);
    assert.equal(new URL(url).pathname, '/a/', `${name} must land on the /a/ path`);
    seen.add(new URL(url).host);
  }
  assert.ok(seen.size > 1, 'a dev build ships more than one app host — if this fails the derivation collapsed to one');
});

test('appLaunchUrl: exactly one slash between host and /a/ regardless of the entry trailing slash', () => {
  for (const name of Object.keys(ENVIRONMENTS)) {
    assert.equal(/\/\/[^/]+\/a\/$/.test(appLaunchUrl(name)), true, `${name} produced ${appLaunchUrl(name)}`);
  }
});

test('appLaunchUrl: an unknown (user-added) environment falls back to production, matching accessTokenUrl', () => {
  assert.equal(appLaunchUrl('a-custom-region-nobody-shipped'), 'https://fortmesa.com/a/');
  assert.match(accessTokenUrl('a-custom-region-nobody-shipped'), /^https:\/\/fortmesa\.com\//);
});

// Superseded 2026-09-09 (0.7.8): /accountProfile hangs off the /a/ FE root,
// not the host root. The host root is the marketing site, and the old shape
// shipped a create-token link that landed nowhere (PO report).
test('accessTokenUrl hangs /accountProfile off the /a/ FE root, like every other FE deep link', () => {
  assert.equal(accessTokenUrl('prod'), 'https://fortmesa.com/a/accountProfile#createToken');
  assert.equal(accessTokenUrl('prod'), `${appLaunchUrl('prod')}accountProfile#createToken`);
});

test('the launcher command opens appLaunchUrl, not the raw ENVIRONMENTS app entry', async () => {
  const src = await readFile(new URL('../../dist/extension/saferoom-launcher.js', import.meta.url), 'utf-8');
  assert.match(src, /appLaunchUrl\(env\)/, 'it must derive the /a/ URL');
  assert.equal(
    /openExternal\(\s*vscode\.Uri\.parse\(\s*ENVIRONMENTS\[env\]/.test(src),
    false,
    'it must not open the bare app host any more',
  );
});
