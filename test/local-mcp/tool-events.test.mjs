import { strict as assert } from 'node:assert';
import test from 'node:test';
import { beginToolEvent } from '../../dist/local-mcp/tool-events.js';

// ── Why this file exists ────────────────────────────────────────────────
//
// `proxy.ts`'s `tools/call` handler is the ONE place every MCP call an agent
// makes passes through, and it is where the Event viewer's rows are produced.
// Two things about that hook are load-bearing and neither is visible in a
// screenshot:
//
//  1. **Exactly one row per call.** The handler has six return paths and will
//     grow more. A path that opens a row and never settles it leaves a `●`
//     that looks to a user like a hung tool call, and a path that settles
//     twice double-counts. So `settle` is idempotent and `finalize()` — which
//     `proxy.ts` calls from a `finally` — closes any row a future return path
//     forgot about.
//  2. **The row's contents are derived, never copied.** The arguments object
//     reaches the summariser and stops there.
//
// The clock is injected so the duration assertion is exact rather than a
// tolerance window.

function recorder() {
  const emitted = [];
  return { emitted, client: { emit: (record) => emitted.push(record), close: () => {} } };
}

/** A clock that advances by `step` ms on every read after the first. */
function clock(start, step) {
  let value = start;
  let first = true;
  return () => {
    if (first) {
      first = false;
      return value;
    }
    value += step;
    return value;
  };
}

const noNames = () => undefined;

test('one call produces exactly two records: the running row, then the same row settled', () => {
  const { emitted, client } = recorder();

  const event = beginToolEvent(client, 'grc_documents_upload_url', {}, noNames, clock(1_000, 120));
  event.settle('ok', { relayed: true });

  assert.equal(emitted.length, 2);
  const [running, settled] = emitted;

  assert.equal(running.id, settled.id, 'the settled record must reuse the id so the row updates in place');
  assert.equal(running.kind, 'tool.call');
  assert.equal(running.outcome, 'running');
  assert.equal(running.durationMs, undefined, 'a running row has no duration yet');

  assert.equal(settled.outcome, 'ok');
  assert.equal(settled.durationMs, 120);
  assert.equal(settled.relayed, true);
  assert.equal(settled.family, 'documents');
  assert.equal(settled.method, 'upload_url');
  assert.equal(settled.ts, running.ts, 'the row keeps its START time — the timeline is ordered by arrival');
});

test('settle is idempotent: a second settle cannot double-count or overwrite the outcome', () => {
  const { emitted, client } = recorder();

  const event = beginToolEvent(client, 'grc_controls_read', {}, noNames, clock(0, 5));
  event.settle('ok');
  event.settle('error', { errorClass: '5xx' });

  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].outcome, 'ok');
  assert.equal(event.isSettled(), true);
});

test('finalize closes a row a return path forgot — the structural guarantee proxy.ts relies on', () => {
  const { emitted, client } = recorder();

  const event = beginToolEvent(client, 'grc_plans', {}, noNames, clock(0, 7));
  // No settle: this stands in for a future `return` added to the handler by
  // someone who did not know about the timeline.
  event.finalize();

  assert.equal(emitted.length, 2, 'the row must be closed, not left running forever');
  assert.equal(emitted[1].outcome, 'error');
  assert.equal(emitted[1].errorClass, 'error');
});

test('finalize after a real settle changes nothing', () => {
  const { emitted, client } = recorder();

  const event = beginToolEvent(client, 'grc_controls_read', {}, noNames, clock(0, 3));
  event.settle('error', { errorClass: '401 expired', relayed: true });
  event.finalize();

  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].errorClass, '401 expired');
});

test('the scope column is a name when the lock knows one, a short id when it does not', () => {
  const scopeId = '65f1c0ffee0000000000aa01';

  const locked = recorder();
  beginToolEvent(locked.client, 'grc_controls_read', { scopeId }, (id) => (id === scopeId ? 'barsoommsp' : undefined));
  assert.equal(locked.emitted[0].scope, 'barsoommsp');

  const unlocked = recorder();
  beginToolEvent(unlocked.client, 'grc_controls_read', { scopeId }, noNames);
  assert.equal(unlocked.emitted[0].scope, '00aa01', 'an unlocked proxy knows ids, not names — so it prints an id');
});

test('nothing from the arguments object reaches the emitted records', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS10b2tlbi1mb3ItdGVzdA.c2lnbmF0dXJl';
  const { emitted, client } = recorder();

  const event = beginToolEvent(
    client,
    'grc_documents_upload_url',
    {
      token: secret,
      path: '/Users/jane.doe/Documents/board-minutes.docx',
      email: 'jane.doe@customer.example.com',
      scopeId: '65f1c0ffee0000000000aa01',
    },
    noNames,
  );
  event.settle('ok', { relayed: false });

  const rendered = JSON.stringify(emitted);
  for (const leak of [secret, 'jane.doe', 'board-minutes', '/Users/', 'customer.example.com']) {
    assert.equal(rendered.includes(leak), false, `the emitted records leaked ${leak}`);
  }
});
