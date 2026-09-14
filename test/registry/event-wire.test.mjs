import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventBus } from '../../dist/registry/events/event-bus.js';
import { startEventSink } from '../../dist/registry/events/event-sink.js';
import { createEventClient } from '../../dist/local-mcp/event-client.js';
import { beginToolEvent } from '../../dist/local-mcp/tool-events.js';
import { toEventRows } from '../../dist/registry/events/event-row.js';

// ── Why this file exists ────────────────────────────────────────────────
//
// Every other Event-viewer test exercises one module against fixtures. This
// one exercises the actual seam the feature lives or dies on: the local MCP
// proxy runs in a DIFFERENT OS PROCESS from the extension host, so a record
// has to survive a real socket, a real NDJSON framing, and a real sanitiser
// before a pane can render it.
//
// So the check is a round trip, and it is deliberately read back through a
// different path than it was written: written through the PROXY's tracker
// (`beginToolEvent` -> `createEventClient`), read back through the VIEW's
// projection (`EventBus.snapshot` -> `toEventRows`). A test that asserted on
// what the emitter emitted would prove nothing about what a user sees.
//
// ── Two traps this file has already fallen into ─────────────────────────
//
// 1. `EventClient` is fire-and-forget BY DESIGN: a record emitted before the
//    socket connects is dropped, not queued (`event-client.ts`). So the drill
//    cannot just emit and wait — it has to get the connection up first. It
//    does that with a throwaway WARM-UP record, then clears the bus, so the
//    assertions below run against exactly one record. An earlier version
//    instead retried `beginToolEvent` until something landed, which left TWO
//    `running` rows in the bus and made "the same row settles in place"
//    untestable.
// 2. `EventBus.snapshot()` is OLDEST-FIRST. Indexing `[0]` to find "the row
//    we just made" reads the oldest one instead. Records here are looked up
//    by id, and ordering is asserted only through `toEventRows`, which is the
//    function that actually owns newest-first.

const quiet = { info: () => {}, warn: () => {} };

/** Poll until `predicate` holds or the budget expires — the wire is async. */
async function until(predicate, budgetMs = 3_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}

/**
 * Emit throwaway records until one arrives, proving the socket is up, then
 * clear the bus. Returns false if the connection never landed.
 *
 * The DRAIN before the clear is load-bearing. The retry loop emits a record
 * every 20ms and stops the moment the first one lands, so by then one or more
 * siblings are still in flight; clearing immediately lets those arrive
 * afterwards and seed the "empty" bus with warm-up rows. That is what made an
 * earlier version of this file fail with "the running record never crossed the
 * wire" — the record HAD crossed, it just was not the only thing in there.
 */
async function warmUp(client, bus) {
  let n = 0;
  const connected = await until(() => {
    client.emit({
      id: `warmup${String(n++).padStart(5, '0')}`,
      ts: Date.now(),
      kind: 'tool.call',
      family: 'warmup',
      outcome: 'ok',
    });
    return bus.size > 0;
  });
  await delay(200);
  bus.clear();
  return connected;
}

test('a tool call in the proxy process becomes a row in the extension host, with nothing extra attached', async (t) => {
  if (process.platform === 'win32') {
    t.skip('named-pipe paths are not directory-scoped; this drill is POSIX-only');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'fm-events-'));
  const socketPath = join(dir, 'events.sock');
  const bus = new EventBus(10);
  const sink = startEventSink(bus, quiet, socketPath);
  let client;
  // Registered BEFORE the assertions: a failing assert must not leave a
  // listening socket behind, or the whole `node --test` run hangs on exit
  // instead of reporting the failure. It has done exactly that once.
  t.after(async () => {
    client?.close();
    sink.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  assert.ok(await until(() => sink.boundPath !== undefined), 'the sink never bound its socket');

  // The socket must be owner-only: it names the scopes an agent is working in.
  assert.equal(((await stat(socketPath)).mode & 0o777).toString(8), '600');

  client = createEventClient(socketPath);
  assert.ok(await warmUp(client, bus), 'the client never connected to the sink');
  assert.equal(bus.size, 0, 'warm-up should have left the bus empty');

  const secret = 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS10b2tlbi1mb3ItdGVzdA.c2lnbmF0dXJl';
  const event = beginToolEvent(
    client,
    'grc_documents_upload_url',
    { scopeId: '65f1c0ffee0000000000aa01', token: secret, path: '/Users/jane.doe/board-minutes.docx' },
    () => undefined,
  );
  assert.ok(
    await until(() => bus.snapshot().some((r) => r.family === 'documents')),
    'the running record never crossed the wire',
  );
  const opened = bus.snapshot().find((r) => r.family === 'documents');
  assert.equal(opened.outcome, 'running');
  assert.equal(bus.size, 1, 'a warm-up record survived the drain');

  // ...now settle it, and confirm the SAME row updates rather than a second appearing.
  event.settle('error', { errorClass: '401 expired', relayed: true });
  assert.ok(
    await until(() => bus.snapshot().some((r) => r.id === opened.id && r.outcome === 'error')),
    'the settle never reached the bus',
  );
  assert.equal(bus.size, 1, 'settling across the wire must update the row in place, not append');

  // Read back through the VIEW's projection, not the emitter's.
  const rows = toEventRows(bus.snapshot(30), 30);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'documents · upload_url');
  assert.equal(rows[0].glyph, '✕');
  assert.equal(rows[0].errorClass, '401 expired');
  assert.equal(rows[0].where, 'gateway');
  assert.equal(rows[0].duration !== undefined, true, 'a settled row must carry a duration');
  assert.equal(rows[0].scope, '00aa01', 'no name was known, so the row shows a short id');

  const rendered = JSON.stringify(rows);
  for (const leak of [secret, 'jane.doe', 'board-minutes', '65f1c0ffee']) {
    assert.equal(rendered.includes(leak), false, `the rendered row leaked ${leak}`);
  }

  client.close();
  client = undefined;
  sink.dispose();

  // No remnants: the endpoint is removed when the listener disposes.
  await assert.rejects(stat(socketPath), 'the socket file was left behind after dispose');
});

test('the scope NAME is used when the proxy is locked to that scope, and it is still not the raw id', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX-only drill');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'fm-events-'));
  const socketPath = join(dir, 'events.sock');
  const bus = new EventBus(10);
  const sink = startEventSink(bus, quiet, socketPath);
  let client;
  t.after(async () => {
    client?.close();
    sink.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(await until(() => sink.boundPath !== undefined));

  client = createEventClient(socketPath);
  assert.ok(await warmUp(client, bus), 'the client never connected to the sink');

  // `nameFor` returns a name exactly when the proxy is scope-locked — which is
  // exactly when that name is already rendered in the Scope selector.
  beginToolEvent(client, 'grc_controls_read', { scopeId: '65f1c0ffee0000000000aa01' }, () => 'Acme_Prod');
  assert.ok(await until(() => bus.snapshot().some((r) => r.family === 'controls')), 'nothing crossed the wire');

  const row = toEventRows(bus.snapshot(30), 30).find((r) => r.subject.startsWith('controls'));
  assert.equal(row.scope, 'Acme_Prod');
  assert.equal(JSON.stringify(row).includes('65f1c0ffee'), false, 'the raw scope id reached the row');
});

test('a record written to the socket by an untrusted local writer cannot inject text into the pane', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX-only drill');
    return;
  }

  const { connect } = await import('node:net');
  const dir = await mkdtemp(join(tmpdir(), 'fm-events-'));
  const socketPath = join(dir, 'events.sock');
  const bus = new EventBus(10);
  const sink = startEventSink(bus, quiet, socketPath);
  let socket;
  t.after(async () => {
    socket?.destroy();
    sink.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(await until(() => sink.boundPath !== undefined));

  socket = connect(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    `${JSON.stringify({
      id: 'deadbeef0001',
      ts: Date.now(),
      kind: 'tool.call',
      family: '<img src=x onerror=alert(1)>',
      outcome: 'ok',
    })}\n`,
  );
  socket.write(
    `${JSON.stringify({
      id: 'deadbeef0002',
      ts: Date.now(),
      kind: 'tool.call',
      family: 'documents',
      outcome: 'ok',
      method: 'a'.repeat(400),
    })}\n`,
  );
  // An unknown kind, and an extra key that a consumer might otherwise read.
  socket.write(
    `${JSON.stringify({
      id: 'deadbeef0003',
      ts: Date.now(),
      kind: 'tool.exfiltrate',
      family: 'documents',
      outcome: 'ok',
      payload: 'secret-contents-of-a-document',
    })}\n`,
  );
  socket.write('total garbage, not even json\n');

  assert.ok(await until(() => bus.size === 1), 'the one legitimate row never arrived');
  await delay(150);

  // The hostile family and the unknown kind are rejected outright; the
  // over-long method is dropped while the record itself survives as a plain
  // `documents` row.
  assert.equal(bus.size, 1, 'a rejected record was admitted');
  const [row] = toEventRows(bus.snapshot(30), 30);
  assert.equal(row.subject, 'documents');
  const held = JSON.stringify(bus.snapshot());
  assert.equal(held.includes('onerror'), false);
  assert.equal(held.includes('secret-contents'), false, 'an unmodelled key rode along into the bus');
});
