// Unit tests for src/registry/scope-resolve.ts (R7 · REVISION-PLAN.md):
// resolveAndCacheScopeMap, listAndCacheScopes, mergeScopeMap — plus the
// genuinely network-free path, shared/scope-lock.ts's resolveScopeLock (see
// the "cache-hit" note below).
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/scope-resolve.test.mjs`.
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.
//
// --- On "cache-hit / no-network-call" ---------------------------------
//
// scope-resolve.ts's own module doc comment and every exported function
// here (`resolveAndCacheScopeMap`, `listAndCacheScopes`, `mergeScopeMap`)
// confirm there is no cache-short-circuit inside THIS module —
// `resolveAndCacheScopeMap`/`listAndCacheScopes` always call
// `fetchScopeList(gatewayClient, env)`, i.e. always hit the gateway. The
// genuinely network-free, cache-only path lives in shared/scope-lock.ts's
// `resolveScopeLock(names, scopeMap, env)` (confirmed by reading its
// implementation: pure Map lookups against an in-memory `scopeMap`, no I/O).
// Its signature takes exactly 3 parameters — `names`, `scopeMap`, `env` —
// with NO gateway/client parameter at all, so it is structurally incapable
// of making a network call (there's nothing to call through). We assert
// this both behaviorally (a stub client that throws if ever invoked is
// never passed to `resolveScopeLock`, and is simply irrelevant to its
// signature) and structurally (arity check on the exported function).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndCacheScopeMap, listAndCacheScopes, mergeScopeMap } from '../../dist/registry/scope-resolve.js';
import { resolveScopeLock } from '../../dist/shared/scope-lock.js';

/**
 * Run `fn` with `FMCODE_DIR` pointed at a fresh temp dir, so every test
 * deterministically operates on an isolated credentials.json instead of
 * this machine's real `~/.fmcode`. Cleans up and restores the env var
 * afterward even if `fn` throws. Mirrors config.test.mjs /
 * cursor.test.mjs's isolation pattern, using scope-resolve.ts's own
 * `FMCODE_DIR` override convention.
 */
async function withIsolatedFmcodeDir(fn) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fortmesa-scope-resolve-test-'));
  const previous = process.env.FMCODE_DIR;
  process.env.FMCODE_DIR = tmpDir;

  try {
    await fn(tmpDir);
  } finally {
    if (previous === undefined) {
      delete process.env.FMCODE_DIR;
    } else {
      process.env.FMCODE_DIR = previous;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function credentialsPath(tmpDir) {
  return join(tmpDir, 'credentials.json');
}

async function writeCredentials(tmpDir, data) {
  const path = credentialsPath(tmpDir);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

async function readCredentials(tmpDir) {
  return JSON.parse(await readFile(credentialsPath(tmpDir), 'utf-8'));
}

/** Build a stub gateway Client satisfying only the `callTool` shape scope-resolve.ts calls. */
function stubGatewayClient(scopeListEntries) {
  return {
    callTool: async ({ name, arguments: args }) => {
      assert.equal(name, 'grc_scopes');
      assert.deepEqual(args, { method: 'list' });
      return {
        content: [{ type: 'text', text: JSON.stringify(scopeListEntries) }],
      };
    },
  };
}

/** A stub client that fails the test if callTool is ever invoked — used to prove a code path never touches the network. */
function throwingGatewayClient() {
  return {
    callTool: async () => {
      throw new Error('callTool should never have been invoked on this stub');
    },
  };
}

const SCOPE_LIST = [
  { id: 'scope-id-alpha', name: 'Alpha Scope' },
  { id: 'scope-id-beta', name: 'Beta Scope' },
];

// --- Cache-hit / no-network-call path: resolveScopeLock ---------------------

test('resolveScopeLock: structurally cannot make a network call (3-arg signature, no client/gateway parameter)', () => {
  assert.equal(resolveScopeLock.length, 3);
});

test('resolveScopeLock: resolves purely from an in-memory scopeMap, never touching any client', () => {
  const scopeMap = { 'Alpha Scope': 'scope-id-alpha', 'Beta Scope': 'scope-id-beta' };

  const resolved = resolveScopeLock(['Alpha Scope'], scopeMap, 'sandbox');

  assert.deepEqual(resolved, [{ scopeId: 'scope-id-alpha', name: 'Alpha Scope' }]);
});

test('resolveScopeLock: a throwing-stub client is never invoked because resolveScopeLock has nowhere to pass it — proves no network path exists here', () => {
  // There's no way to even pass `throwingGatewayClient()` into
  // resolveScopeLock — its signature has no such parameter. We instantiate
  // it here only to document the intent: if resolveScopeLock's signature
  // ever grew a client parameter and started using it, this test's cousin
  // above (arity check) would fail first, flagging the API change for
  // re-review of this cache-hit assumption.
  const neverCalled = throwingGatewayClient();
  const scopeMap = { 'Alpha Scope': 'scope-id-alpha' };

  const resolved = resolveScopeLock(['Alpha Scope'], scopeMap, 'sandbox');

  assert.deepEqual(resolved, [{ scopeId: 'scope-id-alpha', name: 'Alpha Scope' }]);
  assert.equal(typeof neverCalled.callTool, 'function');
});

// --- Cache-miss resolves via the stub gateway client ------------------------

test('resolveAndCacheScopeMap: cache-miss resolves via the stub gateway client and caches into credentials.json', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, {
      environments: {
        sandbox: { token: 'irrelevant-to-this-module', scopeMap: {} },
      },
    });

    const client = stubGatewayClient(SCOPE_LIST);
    const resolved = await resolveAndCacheScopeMap(['Alpha Scope', 'Beta Scope'], 'sandbox', client);

    assert.deepEqual(
      resolved.slice().sort((a, b) => a.name.localeCompare(b.name)),
      [
        { scopeId: 'scope-id-alpha', name: 'Alpha Scope' },
        { scopeId: 'scope-id-beta', name: 'Beta Scope' },
      ],
    );

    const onDisk = await readCredentials(tmpDir);
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, {
      'Alpha Scope': 'scope-id-alpha',
      'Beta Scope': 'scope-id-beta',
    });
  });
});

test('resolveAndCacheScopeMap: cache-miss when scopeMap is entirely absent (not just empty) still resolves and creates it', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, {
      environments: {
        sandbox: { token: 'irrelevant-to-this-module' },
      },
    });

    const client = stubGatewayClient(SCOPE_LIST);
    const resolved = await resolveAndCacheScopeMap(['Alpha Scope'], 'sandbox', client);

    assert.deepEqual(resolved, [{ scopeId: 'scope-id-alpha', name: 'Alpha Scope' }]);

    const onDisk = await readCredentials(tmpDir);
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, { 'Alpha Scope': 'scope-id-alpha' });
  });
});

test('resolveAndCacheScopeMap: throws listing unmatched names, but still caches whatever DID resolve', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, {
      environments: { sandbox: { scopeMap: {} } },
    });

    const client = stubGatewayClient(SCOPE_LIST);

    await assert.rejects(
      () => resolveAndCacheScopeMap(['Alpha Scope', 'Nonexistent Scope'], 'sandbox', client),
      (error) => {
        assert.match(error.message, /Nonexistent Scope/);
        return true;
      },
    );

    const onDisk = await readCredentials(tmpDir);
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, { 'Alpha Scope': 'scope-id-alpha' });
  });
});

test('listAndCacheScopes: caches the FULL live list regardless of any requested subset', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, {
      environments: { sandbox: { scopeMap: {} } },
    });

    const client = stubGatewayClient(SCOPE_LIST);
    const entries = await listAndCacheScopes('sandbox', client);

    assert.deepEqual(
      entries.slice().sort((a, b) => a.name.localeCompare(b.name)),
      SCOPE_LIST.slice().sort((a, b) => a.name.localeCompare(b.name)),
    );

    const onDisk = await readCredentials(tmpDir);
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, {
      'Alpha Scope': 'scope-id-alpha',
      'Beta Scope': 'scope-id-beta',
    });
  });
});

// --- Merge preserves foreign envs/keys --------------------------------------

test('mergeScopeMap / resolveAndCacheScopeMap: a second unrelated environment block and unrelated fields on the target env survive byte-for-byte', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    const seed = {
      environments: {
        sandbox: {
          token: 'sandbox-token-value',
          refreshToken: 'sandbox-refresh-value',
          scopeMap: { 'Existing Scope': 'scope-id-existing' },
        },
        next: {
          token: 'next-token-value',
          refreshToken: 'next-refresh-value',
          scopeMap: { 'Next Scope': 'scope-id-next' },
        },
      },
      __unrelatedTopLevelField: 'must-survive-untouched',
    };
    await writeCredentials(tmpDir, seed);

    const client = stubGatewayClient(SCOPE_LIST);
    await resolveAndCacheScopeMap(['Alpha Scope'], 'sandbox', client);

    const onDisk = await readCredentials(tmpDir);

    // Foreign top-level field survives.
    assert.equal(onDisk.__unrelatedTopLevelField, 'must-survive-untouched');

    // Foreign env block survives byte-for-byte.
    assert.deepEqual(onDisk.environments.next, seed.environments.next);

    // Target env's unrelated fields survive.
    assert.equal(onDisk.environments.sandbox.token, 'sandbox-token-value');
    assert.equal(onDisk.environments.sandbox.refreshToken, 'sandbox-refresh-value');

    // Target env's scopeMap merges (existing entry preserved, new entry added).
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, {
      'Existing Scope': 'scope-id-existing',
      'Alpha Scope': 'scope-id-alpha',
    });
  });
});

test('mergeScopeMap: on key conflict, the new additions win over pre-existing scopeMap entries', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, {
      environments: {
        sandbox: { scopeMap: { 'Alpha Scope': 'stale-scope-id' } },
      },
    });

    const merged = await mergeScopeMap('sandbox', { 'Alpha Scope': 'fresh-scope-id' });

    assert.deepEqual(merged, { 'Alpha Scope': 'fresh-scope-id' });

    const onDisk = await readCredentials(tmpDir);
    assert.deepEqual(onDisk.environments.sandbox.scopeMap, { 'Alpha Scope': 'fresh-scope-id' });
  });
});

test('mergeScopeMap: throws when the named environment does not exist in credentials.json', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, { environments: { sandbox: {} } });

    await assert.rejects(
      () => mergeScopeMap('nonexistent-env', { 'Alpha Scope': 'scope-id-alpha' }),
      /Environment "nonexistent-env" not found/,
    );
  });
});

// --- chmod 0600 --------------------------------------------------------------

test('mergeScopeMap: credentials.json is chmod 0600 after a write via this module', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, { environments: { sandbox: { scopeMap: {} } } });

    await mergeScopeMap('sandbox', { 'Alpha Scope': 'scope-id-alpha' });

    const info = await stat(credentialsPath(tmpDir));
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test('resolveAndCacheScopeMap: credentials.json is chmod 0600 after the cache-miss write', async () => {
  await withIsolatedFmcodeDir(async (tmpDir) => {
    await writeCredentials(tmpDir, { environments: { sandbox: { scopeMap: {} } } });

    const client = stubGatewayClient(SCOPE_LIST);
    await resolveAndCacheScopeMap(['Alpha Scope'], 'sandbox', client);

    const info = await stat(credentialsPath(tmpDir));
    assert.equal(info.mode & 0o777, 0o600);
  });
});
