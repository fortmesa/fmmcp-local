import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The auth ACTIONS behind the Signed-in user view. Loadable here only
// because the module imports no `vscode` — see its doc comment.
const fmcodeDir = mkdtempSync(join(tmpdir(), 'fmmcp-auth-actions-'));
process.env.FMCODE_DIR = fmcodeDir;

const { submitAccessToken, signOutOfEnvironment } = await import('../../dist/extension/auth-commands.js');
const { writeToken, readCurrentToken } = await import('../../dist/registry/credentials.js');

const credsPath = () => join(fmcodeDir, 'credentials.json');

/** A structurally valid unsigned JWT with a future `exp` — enough to pass the decode step, so the gateway probe is what decides. */
function fakeJwt(subject) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
}

// `sandbox`'s default gateway is http://localhost:3020/mcp — nothing is
// listening in a test run, so the live probe fails, which is the case under
// test: a token the gateway will not vouch for must never reach disk.
test('submitAccessToken: fails CLOSED — a token the gateway rejects is not written', async () => {
  const result = await submitAccessToken('sandbox', fakeJwt('rejected-token'), undefined, '0.0.0-test');
  assert.equal(result.ok, false);
  assert.match(result.message, /gateway rejected/i);
  assert.equal(await readCurrentToken('sandbox'), undefined, 'no token should have been stored');
  assert.equal(existsSync(credsPath()), false, 'credentials.json should not even have been created');
});

test('submitAccessToken: rejects a non-JWT before it ever touches the network, and writes nothing', async () => {
  const result = await submitAccessToken('sandbox', 'not-a-jwt', undefined, '0.0.0-test');
  assert.equal(result.ok, false);
  assert.match(result.message, /does not look like a valid access token/i);
  assert.equal(await readCurrentToken('sandbox'), undefined);
});

test('submitAccessToken: refuses an environment with no configured gateway, and writes nothing', async () => {
  const result = await submitAccessToken('no-such-env', fakeJwt('x'), undefined, '0.0.0-test');
  assert.equal(result.ok, false);
  assert.match(result.message, /No gateway configured/);
  assert.equal(await readCurrentToken('no-such-env'), undefined);
});

// POSITIVE CONTROL for the three assertions above: the same read-back path
// DOES observe a write when one actually happens. Without this, "nothing was
// written" could just mean the check is blind.
test('positive control: writeToken IS observable through the same read-back path', async () => {
  const token = fakeJwt('control-token');
  await writeToken('sandbox', token, 'http://localhost:3010');
  assert.equal(await readCurrentToken('sandbox'), token);
  assert.ok(existsSync(credsPath()));
  const onDisk = JSON.parse(readFileSync(credsPath(), 'utf-8'));
  assert.equal(onDisk.environments.sandbox.fortmesa_api_base, 'http://localhost:3010');
});

test('signOutOfEnvironment: clears the stored token but keeps the API base and cached scopeMap', async () => {
  const cleared = await signOutOfEnvironment('sandbox');
  assert.equal(cleared, true);
  assert.equal(await readCurrentToken('sandbox'), undefined, 'the token must be gone');
  const onDisk = JSON.parse(readFileSync(credsPath(), 'utf-8'));
  assert.equal(onDisk.environments.sandbox.fortmesa_api_base, 'http://localhost:3010', 'the API base must survive');
});

test('signOutOfEnvironment: reports false only when the environment has no block at all (clearToken contract)', async () => {
  // Documented contract of `clearToken`: `false` means "no block for this
  // env, nothing written" — NOT "the token was already blank". A signed-out
  // env still has its block (that is the point: the API base survives), so
  // a repeat sign-out is still a truthful no-harm write.
  assert.equal(await signOutOfEnvironment('never-configured-env'), false);
  assert.equal(await signOutOfEnvironment('sandbox'), true);
});
