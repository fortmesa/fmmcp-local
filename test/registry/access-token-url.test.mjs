import { strict as assert } from 'node:assert';
import test from 'node:test';
import { accessTokenUrl, appLaunchUrl, environmentChoices } from '../../dist/registry/environments.js';

// PO, 2026-09-09: "the create an M2M token route
// 'https://next.fort.blue/accountProfile#createToken' is not accurate. All
// environments require /a/ as the root slug for FE deploy". /accountProfile is
// an fmweb-fe route, so it lives under the app's /a/ channel, not the bare
// host (which is the marketing site).
test('accessTokenUrl: deep-links under the /a/ FE root for a known environment', () => {
  assert.equal(accessTokenUrl('prod'), 'https://fortmesa.com/a/accountProfile#createToken');
});

test('accessTokenUrl: uses the SELECTED environment own app host, still under /a/', () => {
  assert.equal(accessTokenUrl('next'), 'https://next.fort.blue/a/accountProfile#createToken');
  assert.equal(accessTokenUrl('latest'), 'https://latest.fort.blue/a/accountProfile#createToken');
  assert.ok(!accessTokenUrl('next').includes('//accountProfile'));
  assert.ok(!accessTokenUrl('next').includes('/a//'));
});

test('accessTokenUrl: falls back to the production app for an environment Saferoom does not know', () => {
  assert.equal(accessTokenUrl('some-custom-env'), 'https://fortmesa.com/a/accountProfile#createToken');
});

// The regression guard that matters: the two builders must never disagree
// about the FE root again. accessTokenUrl is derived from appLaunchUrl, so a
// change to the channel moves both at once.
test('accessTokenUrl: shares the /a/ FE root with appLaunchUrl for every environment', () => {
  for (const env of ['prod', 'next', 'latest', 'sandbox', 'some-custom-env']) {
    assert.ok(
      accessTokenUrl(env).startsWith(appLaunchUrl(env)),
      `accessTokenUrl(${env}) must be rooted at appLaunchUrl(${env})`,
    );
  }
});

test('environmentChoices: active environment first, remainder alphabetical, labels resolved', () => {
  const choices = environmentChoices(['next', 'prod', 'sandbox'], 'sandbox');
  assert.deepEqual(
    choices.map((c) => c.name),
    ['sandbox', 'next', 'prod'],
  );
  assert.equal(choices[0].active, true);
  assert.equal(choices[0].label, 'Development Sandbox');
  assert.equal(choices[1].active, false);
});

test('environmentChoices: an unknown environment name keeps its raw key as the label', () => {
  const choices = environmentChoices(['zeta'], 'zeta');
  assert.deepEqual(choices, [{ name: 'zeta', label: 'zeta', active: true }]);
});
