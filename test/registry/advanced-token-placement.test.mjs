// Item 3 (PO, 2026-09-05): "advanced paste an access token form should be
// exposed in the settings section via an advanced expansion (not in the
// sidebar view)".
//
// This is a MOVE, so both halves have to be asserted: gone from the sidebar
// view AND present, whole, in the Settings webview. Asserting only the
// destination would pass with the control duplicated in two places, which is
// the likely botched outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const identity = async () => readFile(new URL('../../dist/extension/identity-view.js', import.meta.url), 'utf-8');
const settings = async () => readFile(new URL('../../dist/extension/saferoom-settings.js', import.meta.url), 'utf-8');

test('the sidebar Signed-in user view no longer hosts the token control', async () => {
  const src = await identity();
  for (const gone of ['Advanced: paste an access token', 'tokenInput', 'apiBaseInput', 'submitToken', 'openTokenUi']) {
    assert.equal(src.includes(gone), false, `identity-view still contains "${gone}"`);
  }
});

test('the sidebar keeps ONLY sign-in / sign-out / identity', async () => {
  const src = await identity();
  assert.match(src, /id="signIn"/);
  assert.match(src, /id="signOut"/);
  assert.match(src, /id="details"/);
  assert.match(src, /signOutOfEnvironment/);
  assert.equal(src.includes('submitAccessToken'), false, 'the sidebar must not import the token writer any more');
});

test('the Settings webview hosts the control under an Advanced expansion', async () => {
  const src = await settings();
  assert.match(src, /<details class="advanced" id="advanced">/);
  assert.match(src, /<summary>Advanced: paste an access token<\/summary>/);
  assert.match(src, /id="tokenInput"/);
  assert.match(src, /id="tokenEnvSelect"/, 'the non-active-region choice must survive the move');
  assert.match(src, /id="apiBaseInput"/);
  assert.match(src, /submitAccessToken/, 'the same validated writer, unchanged');
});

test('the PO-approved warning copy moved verbatim — both sentences, not paraphrased', async () => {
  const src = await settings();
  assert.match(src, /Signing in is the recommended route/);
  assert.match(src, /it uses a consent flow and issues short-lived session credentials/);
  assert.match(src, /pinned for up to a year/);
  assert.match(src, /stays valid until it expires or is revoked, wherever it ends up/);
});

test('the /accountProfile deep link moved with it', async () => {
  const src = await settings();
  assert.match(src, /createTokenLink/);
  assert.match(src, /accessTokenUrl/);
});

test('the moved control still never sends a token back down to the webview', async () => {
  const src = await settings();
  const i = src.indexOf("type: 'submitResult'");
  assert.ok(i > -1, 'the result message must exist');
  // Every submitResult payload carries ok/message/needsApiBase only.
  assert.equal(/submitResult'[\s\S]{0,400}token:/.test(src.slice(i - 100)), false, 'no token in a host->webview post');
});

test('the CLI `token set` path is untouched by the move', async () => {
  const cli = await readFile(new URL('../../dist/local-mcp/cli.js', import.meta.url), 'utf-8');
  assert.match(cli, /token/, 'the CLI still exposes its token subcommand');
});
