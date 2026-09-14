// Unit tests for the Event viewer's AUTH half (src/local-mcp/auth-events.ts).
//
// Why this file exists: `auth.refresh` and `auth.expired` were declared in
// `EventKind`, documented, and emitted by nothing. The pane would show a
// sign-in and then go silent for exactly the two session events a user can
// act on — "it renewed itself" and "you need to sign in again". These are
// produced in the PROXY process (inside `resolveCredentials`), not in the
// extension host, which is why they live here rather than in `extension.ts`.
//
// The redaction assertions are the point of the file as much as the emission
// ones: `RefreshOutcome.error` is a free-text OAuth failure string that can
// quote an endpoint or a response body, and it must be reduced to a closed-set
// ErrorClass before anything reaches a webview.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitExpiredEvent, emitRefreshEvent } from '../../dist/local-mcp/auth-events.js';
import { isExpiredCredentialError, resolveCredentials } from '../../dist/local-mcp/auth/token-provider.js';
import { sanitizeIncoming } from '../../dist/registry/events/transport.js';
import { toEventRow } from '../../dist/registry/events/event-row.js';

/** A client that records what it was asked to emit. */
function spy() {
  const emitted = [];
  return { emitted, emit: (record) => emitted.push(record), close: () => {} };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (expSeconds) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: expSeconds })}.signature`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

test('a successful refresh becomes exactly one ok auth.refresh row', () => {
  const client = spy();
  emitRefreshEvent(client, { reason: 'refreshed', token: 'a-brand-new-access-token' });

  assert.equal(client.emitted.length, 1);
  const [record] = client.emitted;
  assert.equal(record.kind, 'auth.refresh');
  assert.equal(record.family, 'auth');
  assert.equal(record.method, 'refresh');
  assert.equal(record.outcome, 'ok');
  assert.equal(record.errorClass, undefined);

  // The replacement TOKEN was handed to this function and must not be in the row.
  assert.equal(JSON.stringify(record).includes('a-brand-new-access-token'), false);
  // `↻` is the auth glyph the spec asks for.
  assert.equal(toEventRow(record).glyph, '↻');
});

test('a raced refresh is still an ok row, distinguishable by method', () => {
  const client = spy();
  emitRefreshEvent(client, { reason: 'raced' });
  assert.equal(client.emitted[0].outcome, 'ok');
  assert.equal(client.emitted[0].method, 'refresh_raced');
});

test('the quiet refresh outcomes emit nothing at all', () => {
  // These fire on essentially every request; a row each would drown the pane.
  for (const reason of ['not-needed', 'no-refresh-token', 'no-client-id']) {
    const client = spy();
    emitRefreshEvent(client, { reason });
    assert.equal(client.emitted.length, 0, `${reason} should be silent`);
  }
});

test('a failed refresh is classified, and its free-text error never reaches the row', () => {
  const client = spy();
  // A realistic OAuth failure string: it quotes an endpoint and a subject.
  emitRefreshEvent(client, {
    reason: 'failed',
    error: 'POST https://login.example.com/oauth2/token failed for jane.doe@acme.com: 401 invalid_grant',
  });

  assert.equal(client.emitted.length, 1);
  const [record] = client.emitted;
  assert.equal(record.kind, 'auth.refresh');
  assert.equal(record.outcome, 'error');
  assert.equal(record.errorClass, '401 expired');

  const rendered = JSON.stringify(toEventRow(record));
  for (const leak of ['login.example.com', 'jane.doe', 'acme.com', 'invalid_grant', 'oauth2/token']) {
    assert.equal(rendered.includes(leak), false, `the refresh-failure row leaked ${leak}`);
  }
});

test('an expired session becomes an auth.expired row that survives the wire sanitiser', () => {
  const client = spy();
  emitExpiredEvent(client);

  const [record] = client.emitted;
  assert.equal(record.kind, 'auth.expired');
  assert.equal(record.outcome, 'error');
  assert.equal(record.errorClass, '401 expired');

  // Every auth record crosses the same socket as the tool rows, so it has to
  // pass the receiving sanitiser unchanged or the pane silently never shows it.
  assert.deepEqual(sanitizeIncoming(JSON.parse(JSON.stringify(record))), record);
});

test('the credential chain flags its expiry refusal as such, and nothing else', async () => {
  // This is the classification `cli.ts` branches on to decide whether an
  // `auth.expired` row is warranted. Pattern-matching the message instead
  // would break the moment the user-facing prose is reworded.
  const dir = await mkdtemp(join(tmpdir(), 'fm-auth-events-'));
  const previousDir = process.env.FMCODE_DIR;
  const previousToken = process.env.FORTMESA_API_TOKEN;
  process.env.FMCODE_DIR = dir;
  delete process.env.FORTMESA_API_TOKEN;

  const writeCreds = (body) => writeFile(join(dir, 'credentials.json'), JSON.stringify(body));

  try {
    await writeCreds({
      environments: {
        next: {
          fortmesa_api_token: jwt(nowSeconds() - 3600),
          fortmesa_api_base: 'https://api-next.dev.fort.blue',
          generated_at: 'unknown',
          expires_at: 'unknown',
        },
      },
    });
    const expired = await resolveCredentials('next').then(
      () => undefined,
      (error) => error,
    );
    assert.ok(expired, 'an hour-dead token should have been refused');
    assert.equal(isExpiredCredentialError(expired), true, 'the expiry refusal was not flagged');

    // A MISSING environment is a configuration fault, not a session event —
    // it must not light up `auth.expired`.
    const missing = await resolveCredentials('nosuchenv').then(
      () => undefined,
      (error) => error,
    );
    assert.ok(missing, 'an unknown env should have been refused');
    assert.equal(isExpiredCredentialError(missing), false, 'a config fault was misread as an expiry');
  } finally {
    if (previousDir === undefined) delete process.env.FMCODE_DIR;
    else process.env.FMCODE_DIR = previousDir;
    if (previousToken !== undefined) process.env.FORTMESA_API_TOKEN = previousToken;
    await rm(dir, { recursive: true, force: true });
  }
});
