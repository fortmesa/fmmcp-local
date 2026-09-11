import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SCHEMA_TTL_MS,
  EXPIRES_AT_META_KEY,
  expiryFromMeta,
  ToolSchemaCache,
} from '../../dist/local-mcp/tool-schema-cache.js';

/** A cache with a controllable clock and a counting fetch. */
function makeCache(opts = {}) {
  let now = 1_000_000;
  let calls = 0;
  const cache = new ToolSchemaCache({
    fetchTools: () => {
      calls += 1;
      if (opts.fail?.() === true) throw new Error('gateway down');
      return Promise.resolve({ tools: opts.tools?.() ?? [{ name: `t${String(calls)}` }], _meta: opts.meta });
    },
    now: () => now,
    log: () => undefined,
  });
  return {
    cache,
    get calls() {
      return calls;
    },
    advance: (ms) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

test('repeated reads inside the window cost one fetch', async () => {
  const h = makeCache();
  await h.cache.get();
  await h.cache.get();
  await h.cache.get();
  assert.equal(h.calls, 1);
});

test('the cache refreshes once the window has passed', async () => {
  const h = makeCache();
  await h.cache.get();
  h.advance(DEFAULT_SCHEMA_TTL_MS - 1);
  await h.cache.get();
  assert.equal(h.calls, 1, 'still inside the window');
  h.advance(2);
  await h.cache.get();
  assert.equal(h.calls, 2, 'past the window');
});

test('invalidate forces the next read to refetch', async () => {
  const h = makeCache();
  await h.cache.get();
  h.cache.invalidate();
  await h.cache.get();
  assert.equal(h.calls, 2);
});

test('concurrent misses collapse into a single fetch', async () => {
  let calls = 0;
  const cache = new ToolSchemaCache({
    fetchTools: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { tools: [{ name: 'a' }] };
    },
  });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1);
});

test('a failed refresh serves the last good list rather than nothing', async () => {
  // An agent that momentarily sees zero tools may drop them from its context,
  // so a stale list is the better answer.
  let down = false;
  let calls = 0;
  let now = 1_000_000;
  const cache = new ToolSchemaCache({
    fetchTools: () => {
      calls += 1;
      if (down) throw new Error('gateway down');
      return Promise.resolve({ tools: [{ name: 'good' }] });
    },
    now: () => now,
    log: () => undefined,
  });
  await cache.get();
  down = true;
  now += DEFAULT_SCHEMA_TTL_MS + 1;
  assert.deepEqual(await cache.get(), [{ name: 'good' }]);
  assert.equal(calls, 2, 'it did attempt the refresh');
});

test('a first fetch that fails with nothing cached propagates', async () => {
  const cache = new ToolSchemaCache({
    fetchTools: () => Promise.reject(new Error('gateway down')),
    log: () => undefined,
  });
  await assert.rejects(() => cache.get(), /gateway down/);
});

test('a gateway-published expiry overrides the default window', async () => {
  const h = makeCache({ meta: { [EXPIRES_AT_META_KEY]: new Date(1_000_000 + 60_000).toISOString() } });
  await h.cache.get();
  h.advance(59_000);
  await h.cache.get();
  assert.equal(h.calls, 1, 'still inside the published window');
  h.advance(2_000);
  await h.cache.get();
  assert.equal(h.calls, 2, 'past the published window, well before the default');
});

test('an unusable published expiry falls back to the default rather than breaking', () => {
  const now = 1_000_000;
  assert.equal(expiryFromMeta(undefined, now), undefined);
  assert.equal(expiryFromMeta({}, now), undefined);
  assert.equal(expiryFromMeta({ [EXPIRES_AT_META_KEY]: 'nonsense' }, now), undefined);
  assert.equal(expiryFromMeta({ [EXPIRES_AT_META_KEY]: 12345 }, now), undefined, 'not a string');
  // Already past: honouring it would force a fetch on every single call.
  assert.equal(expiryFromMeta({ [EXPIRES_AT_META_KEY]: new Date(now - 1).toISOString() }, now), undefined);
  assert.equal(expiryFromMeta({ [EXPIRES_AT_META_KEY]: new Date(now + 1000).toISOString() }, now), now + 1000);
});
