import { strict as assert } from 'node:assert';
import test from 'node:test';
import { EventBus, SIDEBAR_EVENT_LIMIT, FULLSCREEN_EVENT_LIMIT } from '../../dist/registry/events/event-bus.js';

// ── Why this file exists ────────────────────────────────────────────────
//
// The Event viewer's buffer carries two promises that are invisible in the
// UI until they are broken:
//
//  1. **Bounded.** It is fed by every MCP tool call an agent makes. A missing
//     eviction rule is not a cosmetic bug, it is an extension host that grows
//     for as long as the window is open.
//  2. **Cleared by a reload, always.** The PO's requirement is "limited
//     recall = this IDE load only, no data remnants". Nothing in a screenshot
//     distinguishes a buffer that is in memory from one quietly backed by
//     `globalState`, so the property has to be asserted here.
//
// Both are asserted against the real class, not a fixture of it.

function record(id, overrides = {}) {
  return { id, ts: 1_000, kind: 'tool.call', family: 'documents', outcome: 'ok', ...overrides };
}

test('evicts the oldest record once capacity is exceeded', () => {
  const bus = new EventBus(3);
  for (const id of ['a', 'b', 'c', 'd']) bus.publish(record(id));

  assert.equal(bus.size, 3);
  assert.deepEqual(
    bus.snapshot().map((r) => r.id),
    ['b', 'c', 'd'],
    'the oldest record must be evicted, not the newest dropped',
  );
});

test('snapshot returns oldest-first, and honours a smaller limit', () => {
  const bus = new EventBus(10);
  for (const id of ['a', 'b', 'c']) bus.publish(record(id));

  assert.deepEqual(
    bus.snapshot().map((r) => r.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    bus.snapshot(2).map((r) => r.id),
    ['b', 'c'],
    'a limit takes the MOST RECENT n, not the first n',
  );
});

test('settle updates a running record in place rather than appending a second row', () => {
  const bus = new EventBus(10);
  bus.publish(record('x', { outcome: 'running' }));

  const settled = bus.settle('x', { outcome: 'error', durationMs: 42, errorClass: '5xx' });

  assert.equal(bus.size, 1, 'settling must not add a row');
  assert.equal(settled.outcome, 'error');
  assert.equal(bus.snapshot()[0].durationMs, 42);
  assert.equal(bus.snapshot()[0].errorClass, '5xx');
});

test('settling an evicted id is a no-op, not a resurrection', () => {
  const bus = new EventBus(2);
  bus.publish(record('old', { outcome: 'running' }));
  bus.publish(record('b'));
  bus.publish(record('c'));

  assert.equal(bus.settle('old', { outcome: 'ok' }), undefined);
  assert.deepEqual(
    bus.snapshot().map((r) => r.id),
    ['b', 'c'],
    'a settle for an evicted record must not reinsert a stale row',
  );
});

test('a fresh bus is empty, and clear() empties it — the whole of "this IDE load only"', () => {
  // A new EventBus is what `activate()` constructs on every window reload, so
  // "starts empty with no argument, no restore hook, no async load" IS the
  // no-remnants guarantee. If this ever needs a `await bus.load()` to pass,
  // the retention decision has been changed.
  assert.equal(new EventBus().size, 0);

  const bus = new EventBus(5);
  bus.publish(record('a'));
  bus.publish(record('b'));
  bus.clear();

  assert.equal(bus.size, 0);
  assert.deepEqual(bus.snapshot(), []);
});

test('subscribers see publishes and settles, and a throwing subscriber cannot break the producer', () => {
  const bus = new EventBus(5);
  const seen = [];
  bus.subscribe(() => {
    throw new Error('a log sink that blew up');
  });
  const subscription = bus.subscribe((r) => seen.push(`${r.id}:${r.outcome}`));

  bus.publish(record('a', { outcome: 'running' }));
  bus.settle('a', { outcome: 'ok' });

  assert.deepEqual(seen, ['a:running', 'a:ok']);

  subscription.dispose();
  bus.publish(record('b'));
  assert.equal(seen.length, 2, 'a disposed subscription must stop receiving');
});

test('the two view limits are the ones the PO asked for', () => {
  assert.equal(SIDEBAR_EVENT_LIMIT, 30);
  assert.equal(FULLSCREEN_EVENT_LIMIT, 200);
});
