import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adoptedRegionNotice,
  hasUsableCredential,
  regionChipLabel,
  regionCredentialState,
  shouldAdoptSavedRegion,
  switchOfferNotice,
} from '../../dist/registry/region-identity.js';

// PO, 2026-09-09: saving an access token for a non-default data region
// "didn't actually add a selectable identity". The credential landed in
// credentials.json while activeEnv (config.json) stayed on prod, so every
// surface kept rendering an empty production region.

test('regionCredentialState: no token is "none"', () => {
  assert.equal(regionCredentialState({ hasToken: false }), 'none');
  assert.equal(regionCredentialState({ hasToken: false, expired: true, kind: 'sign-in' }), 'none');
});

test('regionCredentialState: a provably dead token is "expired", whatever its kind', () => {
  assert.equal(regionCredentialState({ hasToken: true, expired: true, kind: 'sign-in' }), 'expired');
  assert.equal(regionCredentialState({ hasToken: true, expired: true, kind: 'access-token' }), 'expired');
});

test('regionCredentialState: an opaque token (expiry unknown) is NOT treated as expired', () => {
  assert.equal(regionCredentialState({ hasToken: true, kind: 'access-token' }), 'token-saved');
  assert.equal(regionCredentialState({ hasToken: true, expired: undefined, kind: 'sign-in' }), 'signed-in');
});

test('regionCredentialState: kind decides between the two live states', () => {
  assert.equal(regionCredentialState({ hasToken: true, expired: false, kind: 'sign-in' }), 'signed-in');
  assert.equal(regionCredentialState({ hasToken: true, expired: false, kind: 'access-token' }), 'token-saved');
});

test('regionChipLabel: the four chips the Data region list renders', () => {
  assert.equal(regionChipLabel('signed-in'), 'Signed in');
  assert.equal(regionChipLabel('token-saved'), 'Token saved');
  assert.equal(regionChipLabel('expired'), 'Session expired');
  assert.equal(regionChipLabel('none'), 'Not signed in');
});

test('hasUsableCredential: an expired credential does not count as occupied', () => {
  assert.equal(hasUsableCredential('signed-in'), true);
  assert.equal(hasUsableCredential('token-saved'), true);
  assert.equal(hasUsableCredential('expired'), false);
  assert.equal(hasUsableCredential('none'), false);
});

// ── the adoption rule ────────────────────────────────────────────────────

test('shouldAdoptSavedRegion: THE REPORTED CASE — prod is active and empty, a next token is saved, so next becomes active', () => {
  assert.equal(shouldAdoptSavedRegion({ savedEnv: 'next', activeEnv: 'prod', activeState: 'none' }), true);
});

test('shouldAdoptSavedRegion: does NOT move a user who is signed in to the active region', () => {
  assert.equal(shouldAdoptSavedRegion({ savedEnv: 'next', activeEnv: 'prod', activeState: 'signed-in' }), false);
  assert.equal(shouldAdoptSavedRegion({ savedEnv: 'next', activeEnv: 'prod', activeState: 'token-saved' }), false);
});

test('shouldAdoptSavedRegion: an expired active credential is not a session worth keeping', () => {
  assert.equal(shouldAdoptSavedRegion({ savedEnv: 'next', activeEnv: 'prod', activeState: 'expired' }), true);
});

test('shouldAdoptSavedRegion: saving for the region already active is never a switch', () => {
  for (const activeState of ['none', 'expired', 'signed-in', 'token-saved']) {
    assert.equal(shouldAdoptSavedRegion({ savedEnv: 'prod', activeEnv: 'prod', activeState }), false);
  }
});

test('the notices name the region, because the user did not ask for the switch', () => {
  assert.equal(adoptedRegionNotice('Functional Testing (Next)'), 'Switched to Functional Testing (Next).');
  assert.match(switchOfferNotice('Functional Testing (Next)', 'Production (NA-US)'), /Production \(NA-US\)/);
  assert.match(switchOfferNotice('Functional Testing (Next)', 'Production (NA-US)'), /Functional Testing \(Next\)/);
});

// ── wiring: the decision is actually reached from the save path ──────────

const dist = (p) => readFile(new URL(`../../dist/${p}`, import.meta.url), 'utf-8');

test('submitAccessToken adopts the saved region and persists it to config.json', async () => {
  const src = await dist('extension/auth-commands.js');
  assert.match(src, /shouldAdoptSavedRegion/, 'the save path must consult the adoption rule');
  assert.match(src, /saveConfig\(/, 'adopting means writing activeEnv to config.json — the file that IS watched');
  assert.match(src, /activeEnv: savedEnv/);
  assert.match(src, /switchOfferNotice/, 'when it does not adopt it must offer the switch instead');
});

test('the settings panel chips every region and renders the switch offer', async () => {
  const src = await dist('extension/saferoom-settings.js');
  assert.match(src, /readRegionCredentialState/, 'each region row needs its credential state');
  assert.match(src, /regionChipLabel/, 'the host decides the chip words, not the webview');
  assert.match(src, /credentialChip/);
  assert.match(src, /renderRegionList/);
  assert.match(src, /offerSwitch/);
  assert.match(src, /regionNote/);
});

test('the active region is still switched through the one atomic control (setEnv)', async () => {
  const src = await dist('extension/saferoom-settings.js');
  assert.match(src, /type: 'setEnv', env: message\.offerSwitch\.env/, 'the offer reuses the existing switch message');
});

test('sign-in still targets the ACTIVE region, not a saved-for one', async () => {
  const src = await dist('extension/sign-in-page.js');
  assert.match(src, /config\.activeEnv/);
});
