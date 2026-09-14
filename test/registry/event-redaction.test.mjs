import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  classifyError,
  formatDuration,
  formatRelativeTime,
  scopeLabel,
  scopeShortId,
  sidebarLine,
  summarizeToolCall,
} from '../../dist/registry/events/summarize.js';
import { sanitizeIncoming, decodeLines } from '../../dist/registry/events/transport.js';

// ── Why this file exists ────────────────────────────────────────────────
//
// The Event viewer is a screen that shows what an agent is doing with a GRC
// account, and the PO's constraint on it is a PRIVACY constraint, not a
// styling one: never a request or response payload, never a file path, never
// a document title, never a user email, never a token.
//
// A test that only checks "the happy-path string looks right" does not test
// that. So every case below feeds the summariser something it must NOT
// reveal, and asserts on the absence. The two marked POSITIVE CONTROL are the
// load-bearing ones: a fake bearer token and a real-shaped file path are
// planted in the arguments object, and the assertion is that no part of them
// survives into any string the pane can render.

const SECRET = 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS10b2tlbi1mb3ItdGVzdA.c2lnbmF0dXJl';
const SECRET_PATH = '/Users/jane.doe/Documents/SOC2-evidence/Q3-payroll-export.xlsx';
const SECRET_EMAIL = 'jane.doe@customer.example.com';

test('POSITIVE CONTROL: a token, a path and an email planted in the arguments never reach the summary', () => {
  const args = {
    scopeId: '65f1c0ffee0000000000aa01',
    token: SECRET,
    authorization: `Bearer ${SECRET}`,
    path: SECRET_PATH,
    filePath: SECRET_PATH,
    title: 'Q3 payroll export (confidential)',
    userEmail: SECRET_EMAIL,
    body: { nested: { deeper: SECRET } },
  };

  const summary = summarizeToolCall('grc_documents_upload_url', args);
  const rendered = JSON.stringify(summary);

  assert.deepEqual(summary, { family: 'documents', method: 'upload_url' });
  for (const secret of [SECRET, SECRET_PATH, SECRET_EMAIL, 'payroll', 'confidential', 'Bearer']) {
    assert.equal(rendered.includes(secret), false, `summary leaked ${secret}`);
  }
});

test('POSITIVE CONTROL: a secret smuggled into the one argument we DO read is rejected by the length cap', () => {
  // `method` is the single argument field the summariser reads at all, for
  // verb-dispatched tools like grc_scopes. It is the only conceivable route
  // in, so it is capped and character-classed rather than trusted.
  assert.deepEqual(summarizeToolCall('grc_scopes', { method: SECRET }), { family: 'scopes' });
  assert.deepEqual(summarizeToolCall('grc_scopes', { method: SECRET_PATH }), { family: 'scopes' });
  assert.deepEqual(summarizeToolCall('grc_scopes', { method: SECRET_EMAIL }), { family: 'scopes' });
  // ...while a genuine verb still comes through.
  assert.deepEqual(summarizeToolCall('grc_scopes', { method: 'list' }), { family: 'scopes', method: 'list' });
});

test('the verb-dispatch branch reads ONLY `method` — every other argument is invisible to it', () => {
  // Coverage gap found by the positive-control drill: the first version of
  // this file only planted secrets on a tool name WITH method segments, which
  // returns before the arguments object is consulted at all. A deliberate
  // leak injected into the OTHER branch went unnoticed. This case exercises
  // that branch directly.
  assert.deepEqual(
    summarizeToolCall('grc_scopes', { method: 'list', path: SECRET_PATH, token: SECRET, email: SECRET_EMAIL }),
    { family: 'scopes', method: 'list' },
  );
  assert.deepEqual(summarizeToolCall('grc_plans', { path: SECRET_PATH, token: SECRET }), { family: 'plans' });
});

test('an unrecognised tool name degrades to "tool" rather than echoing the name', () => {
  assert.deepEqual(summarizeToolCall('../../etc/passwd', {}), { family: 'tool' });
  assert.deepEqual(summarizeToolCall('<img src=x onerror=alert(1)>', {}), { family: 'tool' });
  assert.deepEqual(summarizeToolCall(undefined, {}), { family: 'tool' });
});

test('familiar tool names split into family and method', () => {
  assert.deepEqual(summarizeToolCall('grc_documents_upload_url', {}), { family: 'documents', method: 'upload_url' });
  assert.deepEqual(summarizeToolCall('grc_controls_read', {}), { family: 'controls', method: 'read' });
  assert.deepEqual(summarizeToolCall('grc_plans', {}), { family: 'plans' });
});

test('a scope is a display name only when one is supplied, else a six-character short id', () => {
  // The name is supplied exactly when the proxy is scope-locked to that
  // scope, which is exactly when the Scope selector already shows it.
  assert.equal(scopeLabel('65f1c0ffee0000000000aa01', 'barsoommsp'), 'barsoommsp');
  assert.equal(scopeLabel('65f1c0ffee0000000000aa01', undefined), '00aa01');
  assert.equal(scopeShortId('65f1c0ffee0000000000aa01'), '00aa01');
  assert.equal(scopeShortId(undefined), undefined);
  // A "name" that is actually prose or an address is refused, and we fall
  // back to the id rather than printing it.
  assert.equal(scopeLabel('65f1c0ffee0000000000aa01', SECRET_EMAIL), '00aa01');
});

test('classifyError returns a class and never carries the error text', () => {
  const leaky = new Error(`500 while uploading ${SECRET_PATH} for ${SECRET_EMAIL}`);
  assert.equal(classifyError(leaky), '5xx');

  assert.equal(classifyError(new Error('HTTP 401 Unauthorized')), '401 expired');
  assert.equal(classifyError(new Error('403 Forbidden')), '403 denied');
  assert.equal(classifyError(new Error('request 404 not found')), '4xx');
  assert.equal(classifyError(new Error('socket hang up')), 'network');
  assert.equal(classifyError(new Error('ETIMEDOUT')), 'timeout');
  assert.equal(classifyError({ status: 502 }), '5xx');
  assert.equal(classifyError('something odd'), 'error');
});

test('the WWMD one-liner is short, and carries no payload', () => {
  const now = 1_000_000;
  const ok = sidebarLine(
    {
      id: 'a1',
      ts: now - 2_000,
      kind: 'tool.call',
      family: 'documents',
      method: 'upload_url',
      outcome: 'ok',
      durationMs: 120,
    },
    now,
  );
  assert.equal(ok, '✓  documents · upload_url  120ms  now');

  const failed = sidebarLine(
    {
      id: 'a2',
      ts: now - 200_000,
      kind: 'tool.call',
      family: 'controls',
      method: 'read',
      outcome: 'error',
      errorClass: '401 expired',
      durationMs: 2_400,
    },
    now,
  );
  assert.equal(failed, '✕  controls · read  401 expired  2.4s  3m ago');

  const running = sidebarLine({ id: 'a3', ts: now, kind: 'tool.call', family: 'scopes', outcome: 'running' }, now);
  assert.equal(running, '●  scopes  now');

  // A one-line budget is part of the requirement, so assert it rather than
  // trusting the eye: these must fit a narrow sidebar and wrap to at most two.
  for (const line of [ok, failed, running]) assert.ok(line.length <= 48, `too long for the sidebar: ${line}`);
});

test('durations and relative times read the way a person expects', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(940), '940ms');
  assert.equal(formatDuration(1_500), '1.5s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(undefined), undefined);

  const now = 10_000_000;
  assert.equal(formatRelativeTime(now, now), 'now');
  assert.equal(formatRelativeTime(now - 30_000, now), '30s ago');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
});

test('the wire sanitiser rebuilds records field-by-field and refuses anything unrecognised', () => {
  // The socket is local but it is still an input: any process on this machine
  // could connect and write. A hostile writer may add a ROW; it may not put
  // prose, markup, or a long attacker-chosen string into one.
  const hostile = {
    id: 'ab12cd34',
    ts: 5,
    kind: 'tool.call',
    family: '<script>alert(1)</script>',
    outcome: 'ok',
  };
  assert.equal(sanitizeIncoming(hostile), undefined, 'a family that is not a safe token must reject the whole record');

  assert.equal(sanitizeIncoming({ ...hostile, family: 'documents', kind: 'not.a.kind' }), undefined);
  assert.equal(sanitizeIncoming({ ...hostile, family: 'documents', outcome: 'weird' }), undefined);
  assert.equal(sanitizeIncoming({ ...hostile, family: 'documents', ts: 'soon' }), undefined);

  const clean = sanitizeIncoming({
    ...hostile,
    family: 'documents',
    method: SECRET,
    scope: SECRET_PATH,
    errorClass: 'made up',
    durationMs: -5,
    evil: SECRET,
  });
  assert.deepEqual(clean, { id: 'ab12cd34', ts: 5, kind: 'tool.call', family: 'documents', outcome: 'ok' });
  assert.equal(JSON.stringify(clean).includes(SECRET), false);
  assert.equal('evil' in clean, false, 'unknown keys must not ride along');
});

test('NDJSON decoding keeps a partial line and drops garbage lines', () => {
  const good = JSON.stringify({ id: 'aa', ts: 1, kind: 'tool.call', family: 'plans', outcome: 'ok' });
  const { records, rest } = decodeLines(`${good}\nnot json\n{"partial":`);
  assert.deepEqual(
    records.map((r) => r.id),
    ['aa'],
  );
  assert.equal(rest, '{"partial":');
});
