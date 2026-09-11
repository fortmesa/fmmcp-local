// User-added servers (src/registry/custom-servers.ts).
//
// The four built-in environments are compiled in, and a prod build ships prod
// alone. Neither of those changes. What these pin is the rule that lets a user
// point Saferoom at any other gateway without editing config.json by hand, and
// the `custom: true` marker that keeps a prod build from accepting a `next`
// entry left behind by an earlier dev install.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/custom-servers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomEntry,
  isSelectableServer,
  mergeServerList,
  normalizeCustomServer,
  slugifyServerName,
  SERVER_NAME_MAX,
} from '../../dist/registry/custom-servers.js';
import { ENVIRONMENTS, isSelectableEnv } from '../../dist/registry/environments.js';

const GATEWAY = 'https://mcp.acme.example/mcp';

// -- slugs: the key is the identity, the label is what the user typed -------

test('a display name becomes a key that survives a JSON key and a --env argument', () => {
  assert.equal(slugifyServerName('Acme Production (EU)'), 'acme-production-eu');
  assert.equal(slugifyServerName('  Spaced   Out  '), 'spaced-out');
  assert.equal(slugifyServerName('UPPER'), 'upper');
  assert.equal(slugifyServerName('a.b_c'), 'a-b-c');
});

test('a name with nothing alphanumeric in it produces no key', () => {
  for (const name of ['...', '---', '   ', '!!!']) {
    assert.equal(slugifyServerName(name), '', JSON.stringify(name));
  }
});

// -- validation ------------------------------------------------------------

test('a valid server yields a key and a labelled entry', () => {
  const { key, entry } = normalizeCustomServer({ name: 'Acme EU', gateway: GATEWAY });
  assert.equal(key, 'acme-eu');
  assert.deepEqual(entry, { gateway: GATEWAY, label: 'Acme EU', custom: true });
});

test('the label keeps the typed spelling, the key does not', () => {
  const { key, entry } = normalizeCustomServer({ name: 'Acme Production (EU)', gateway: GATEWAY });
  assert.equal(key, 'acme-production-eu');
  assert.equal(entry.label, 'Acme Production (EU)', 'the user reads the label, not the key');
});

test('an api base is stored when given and omitted when blank', () => {
  const withApi = normalizeCustomServer({ name: 'A', gateway: GATEWAY, api: 'https://api.acme.example' });
  assert.equal(withApi.entry.api, 'https://api.acme.example');
  for (const api of [undefined, '', '   ']) {
    const out = normalizeCustomServer({ name: 'A', gateway: GATEWAY, ...(api === undefined ? {} : { api }) });
    assert.ok(!('api' in out.entry), `blank api must be omitted, not stored empty (${JSON.stringify(api)})`);
  }
});

test('an empty or unusable name is refused with something a person can act on', () => {
  assert.throws(() => normalizeCustomServer({ name: '   ', gateway: GATEWAY }), /Give the server a name/);
  assert.throws(() => normalizeCustomServer({ name: '!!!', gateway: GATEWAY }), /no letters or digits/);
});

test('a name longer than the limit is refused, and the limit is stated', () => {
  const long = 'x'.repeat(SERVER_NAME_MAX + 1);
  assert.throws(() => normalizeCustomServer({ name: long, gateway: GATEWAY }), new RegExp(String(SERVER_NAME_MAX)));
  // The boundary itself is allowed.
  assert.equal(
    normalizeCustomServer({ name: 'y'.repeat(SERVER_NAME_MAX), gateway: GATEWAY }).key.length,
    SERVER_NAME_MAX,
  );
});

test('a name that collides with a built-in is refused', () => {
  // Allowing it would silently shadow the compiled-in environment, and in a
  // prod build would smuggle a non-prod gateway in under the name "prod".
  for (const builtin of Object.keys(ENVIRONMENTS)) {
    assert.throws(
      () => normalizeCustomServer({ name: builtin, gateway: GATEWAY }),
      /collides with the built-in/,
      builtin,
    );
  }
});

test('a name that collides with an existing added server is refused', () => {
  assert.throws(() => normalizeCustomServer({ name: 'Acme EU', gateway: GATEWAY }, ['acme-eu']), /already exists/);
  // Different spelling, same slug: still a collision.
  assert.throws(() => normalizeCustomServer({ name: 'ACME   eu', gateway: GATEWAY }, ['acme-eu']), /already exists/);
});

test('an http gateway is refused, because that is where the bearer token goes', () => {
  assert.throws(() => normalizeCustomServer({ name: 'A', gateway: 'http://mcp.acme.example/mcp' }), /https/);
  assert.throws(() => normalizeCustomServer({ name: 'A', gateway: 'not a url' }), /not a valid URL/);
});

test('an http loopback gateway is allowed, for a locally run server', () => {
  for (const gateway of ['http://localhost:3020/mcp', 'http://127.0.0.1:3020/mcp']) {
    assert.equal(normalizeCustomServer({ name: 'Local', gateway }).entry.gateway, gateway);
  }
});

test('a bad api base is refused just as firmly as a bad gateway', () => {
  assert.throws(() => normalizeCustomServer({ name: 'A', gateway: GATEWAY, api: 'http://api.acme.example' }), /https/);
});

// -- the merged list the Data region control renders ------------------------

test('every built-in this build ships appears in the list', () => {
  const rows = mergeServerList({});
  assert.deepEqual(rows.map((r) => r.name).sort(), Object.keys(ENVIRONMENTS).sort());
  assert.ok(rows.every((r) => r.custom === false));
});

test('an added server appears alongside the built-ins', () => {
  const rows = mergeServerList({ 'acme-eu': { gateway: GATEWAY, label: 'Acme EU', custom: true } });
  const added = rows.find((r) => r.name === 'acme-eu');
  assert.ok(added !== undefined, 'the added server must be listed');
  assert.equal(added.label, 'Acme EU');
  assert.equal(added.custom, true);
  assert.equal(added.advanced, false, 'a server the user added is not hidden behind Advanced');
});

test('a config entry with no custom marker is NOT listed', () => {
  // This is a next/latest leftover from a dev install, not something the user
  // added. Listing it in a prod build would re-offer an environment the build
  // deliberately dropped.
  const rows = mergeServerList({ leftover: { gateway: 'https://mcp-next.example/mcp' } });
  assert.ok(!rows.some((r) => r.name === 'leftover'));
});

test('a config entry overrides a built-in gateway without duplicating the row', () => {
  const rows = mergeServerList({ prod: { gateway: 'https://mirror.example/mcp' } });
  const prod = rows.filter((r) => r.name === 'prod');
  assert.equal(prod.length, 1, 'prod must appear exactly once');
  assert.equal(prod[0].gateway, 'https://mirror.example/mcp');
  assert.equal(prod[0].custom, false, 'overriding a built-in does not make it user-added');
});

test('unlimited servers: the list carries every one of them', () => {
  const many = {};
  for (let i = 0; i < 50; i++) {
    many[`server-${String(i)}`] = {
      gateway: `https://mcp-${String(i)}.example/mcp`,
      label: `Server ${String(i)}`,
      custom: true,
    };
  }
  const rows = mergeServerList(many);
  assert.equal(rows.filter((r) => r.custom).length, 50);
});

// -- selectability, which is where prod-only builds get decided -------------

test('a user-added server is selectable even when the built-in gate refuses it', () => {
  // The prod-only build's gate, simulated: only names it ships are allowed.
  const prodOnlyGate = (name) => name === 'prod';
  const envs = { 'acme-eu': { custom: true }, leftover: {} };

  assert.equal(isSelectableServer('acme-eu', envs, prodOnlyGate), true, 'the whole point of the feature');
  assert.equal(isSelectableServer('prod', envs, prodOnlyGate), true);
  assert.equal(isSelectableServer('leftover', envs, prodOnlyGate), false, 'a dev leftover stays refused');
  assert.equal(isSelectableServer('never-configured', envs, prodOnlyGate), false);
});

test('in a normal build the real gate already permits anything, and adding changes nothing', () => {
  assert.equal(isSelectableServer('anything', {}, isSelectableEnv), true);
});

test('isCustomEntry only answers true for the explicit marker', () => {
  assert.equal(isCustomEntry({ custom: true }), true);
  assert.equal(isCustomEntry({ custom: false }), false);
  assert.equal(isCustomEntry({}), false);
  assert.equal(isCustomEntry(undefined), false);
});

// -- persistence: addCustomServer / removeCustomServer ----------------------

const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { addCustomServer, removeCustomServer, loadConfig, saveConfig } = await import('../../dist/registry/config.js');

async function withIsolatedFmcodeDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fortmesa-servers-test-'));
  const previous = process.env.FMCODE_DIR;
  process.env.FMCODE_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.FMCODE_DIR;
    else process.env.FMCODE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('an added server persists to config.json and reads back', async () => {
  await withIsolatedFmcodeDir(async () => {
    const key = await addCustomServer({ name: 'Acme EU', gateway: GATEWAY });
    assert.equal(key, 'acme-eu');
    const config = await loadConfig();
    assert.deepEqual(config.environments['acme-eu'], { gateway: GATEWAY, label: 'Acme EU', custom: true });
  });
});

test('adding does not switch to the new server', async () => {
  // Saving a credential is what adopts a region. Switching on add would point
  // every panel at an environment with no token, which region-identity.ts
  // exists because of.
  await withIsolatedFmcodeDir(async () => {
    const before = (await loadConfig()).activeEnv;
    await addCustomServer({ name: 'Acme EU', gateway: GATEWAY });
    assert.equal((await loadConfig()).activeEnv, before);
  });
});

test('adding several servers keeps all of them', async () => {
  await withIsolatedFmcodeDir(async () => {
    for (let i = 0; i < 5; i++) {
      await addCustomServer({ name: `Server ${String(i)}`, gateway: `https://mcp-${String(i)}.example/mcp` });
    }
    const config = await loadConfig();
    const added = Object.keys(config.environments).filter((k) => config.environments[k].custom === true);
    assert.equal(added.length, 5);
    // The built-ins are still there too.
    for (const builtin of Object.keys(ENVIRONMENTS)) {
      assert.ok(builtin in config.environments, `${builtin} must survive`);
    }
  });
});

test('a duplicate name is refused against what is already on disk', async () => {
  await withIsolatedFmcodeDir(async () => {
    await addCustomServer({ name: 'Acme EU', gateway: GATEWAY });
    await assert.rejects(() => addCustomServer({ name: 'acme  EU', gateway: GATEWAY }), /already exists/);
  });
});

test('a removed server disappears', async () => {
  await withIsolatedFmcodeDir(async () => {
    await addCustomServer({ name: 'Acme EU', gateway: GATEWAY });
    assert.equal(await removeCustomServer('acme-eu'), true);
    assert.equal('acme-eu' in (await loadConfig()).environments, false);
  });
});

test('removing something that is not an added server is a no-op, not a crash', async () => {
  await withIsolatedFmcodeDir(async () => {
    assert.equal(await removeCustomServer('nope'), false);
    assert.equal(await removeCustomServer('prod'), false, 'a built-in is not removable');
    assert.ok('prod' in (await loadConfig()).environments, 'and it is still there');
  });
});

test('removing the ACTIVE server is refused', async () => {
  // activeEnv pointing at an environment that no longer exists throws on the
  // next startup, and switching the user elsewhere behind their back is worse.
  await withIsolatedFmcodeDir(async () => {
    const key = await addCustomServer({ name: 'Acme EU', gateway: GATEWAY });
    const config = await loadConfig();
    await saveConfig({ ...config, activeEnv: key });
    await assert.rejects(() => removeCustomServer(key), /active data region/);
    assert.ok(key in (await loadConfig()).environments, 'and it survives the refusal');
  });
});

test('a config.json written before this feature still loads', async () => {
  // Every added field is optional for exactly this reason.
  await withIsolatedFmcodeDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    const config = await loadConfig();
    const legacy = { ...config, environments: { prod: { gateway: 'https://mcp.fortmesa.com/mcp' } } };
    await writeFile(join(dir, 'config.json'), JSON.stringify(legacy, null, 2));
    const reloaded = await loadConfig();
    assert.equal(reloaded.environments.prod.gateway, 'https://mcp.fortmesa.com/mcp');
    assert.equal(reloaded.environments.prod.custom, undefined);
  });
});
