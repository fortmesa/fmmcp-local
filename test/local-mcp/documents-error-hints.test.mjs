// Unit tests for the local-tools error-hint path (BRIEF-local-mcp-language.md).
//
// Before this existed, src/shared/api-client.ts parsed only `message`/`error`
// out of a failed response body and threw a bare `Error`. No `code` was ever
// extracted, so a 403/422/5xx from the BE reached the agent as a raw message
// string with no remediation guidance, whatever error code produced it.
//
// Covers:
//   - api-client.ts surfaces `code`/`details` via ApiError (parse order ported
//     from fmmcp-gw's api-client.ts).
//   - tool-helpers.ts's remediationHint() ports fmmcp-gw's taskRemediationHint
//     table (not cross-repo imported) plus the same unknown-code floor text.
//   - documents.ts's catch blocks append remediationHint(error) to the
//     `Document ${method} failed: ...` / `Document delete failed: ...` text.
//
// These drive `download` and `delete` rather than `list`. Since the relay
// refactor, `download` and `upload` are the only methods this process answers
// itself; everything else is handed to the gateway. `download` reaches
// apiFetch directly, so it still exercises the full parse-and-decorate path.
// `delete` is a pure relay, which makes it the case that proves the catch
// block decorates a RELAYED failure too, not only a local one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalToolRegistry } from '../../dist/local-mcp/tools/registry.js';
import { registerDocumentTools } from '../../dist/local-mcp/tools/documents.js';
import { ScopeLock } from '../../dist/shared/scope-lock.js';
import { setApiCredentials, ApiError } from '../../dist/shared/api-client.js';
import { remediationHint, apiErrorCode, apiErrorStatus, apiErrorDetails } from '../../dist/shared/tool-helpers.js';

const SCOPE = '5da7314e388a0c6302e1f776';
const DOC = 'doc-1';
// Never written: every request in this file fails before the write.
const OUT = join(tmpdir(), 'fmmcp-error-hints-never-written');

/**
 * @param relay stand-in for the gateway. Throws by default so a method that
 * relays when the test meant it to run locally fails loudly instead of hanging
 * on an undefined call.
 */
function buildRegistry(relay = () => Promise.reject(new Error('unexpected relay to the gateway'))) {
  const reg = new LocalToolRegistry();
  registerDocumentTools(reg, () => ScopeLock.unlocked(), relay);
  return reg;
}

setApiCredentials('test-token-not-a-real-credential', 'http://api.test.invalid');

/** Stub every fetch with one failing response carrying the given status + flat error body. */
function stubFailure(status, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return () => {
    globalThis.fetch = original;
  };
}

/** Call `download`, which reaches apiFetch directly and propagates through the outer catch. */
async function failingDownload() {
  return buildRegistry().call('grc_documents_read', {
    method: 'download',
    scopeId: SCOPE,
    documentId: DOC,
    filePath: OUT,
  });
}

// -- api-client.ts: code/details parsed out of the error body ---------------

test('apiFetch failure: code and details are extracted from the flat {detail,code,details} body', async () => {
  const restore = stubFailure(422, {
    detail: 'trigger.schedule.rrule INTERVAL must be a positive whole number',
    title: 'Unprocessable Entity',
    code: 'invalid_rrule',
    details: { field: 'schedule.rrule' },
  });
  try {
    const out = await failingDownload();
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /trigger\.schedule\.rrule INTERVAL must be a positive whole number/);
  } finally {
    restore();
  }
});

// -- remediationHint(): each known code, plus the unknown-code floor --------

test('remediationHint: a plain Error (not ApiError, no .code) yields the empty string', () => {
  // apiErrorCode() only recognizes ApiError instances. A bare Error (from the
  // "credentials not initialized" guard, or any non-apiFetch throw) must never
  // accidentally trip the unknown-code floor.
  assert.equal(remediationHint(new Error('boom')), '');
});

const KNOWN_CODES = [
  ['agent_excluded', /human-authority boundary/],
  ['role_required', /requires a scope role/],
  ['invalid_transition', /does not allow this transition/],
  ['interview_not_submitted', /interview is submitted/],
  ['invalid_rrule', /INTERVAL is invalid/],
  ['duplicate_edge', /already exists/],
  ['feature_not_released', /not enabled for this scope/],
];

for (const [code, pattern] of KNOWN_CODES) {
  test(`grc_documents_read download: BE code "${code}" gets a remediation hint appended`, async () => {
    const restore = stubFailure(422, { detail: 'boom', code });
    try {
      const out = await failingDownload();
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, pattern, `hint text for "${code}" must match ${pattern}`);
      assert.match(
        out.content[0].text,
        /^Document download failed: HTTP 422: boom /,
        'original message must be preserved verbatim',
      );
    } finally {
      restore();
    }
  });
}

test('grc_documents_read download: validation_failed with details.errors renders them', async () => {
  const restore = stubFailure(422, {
    detail: 'boom',
    code: 'validation_failed',
    details: { errors: [{ field: 'title', message: 'required' }] },
  });
  try {
    const out = await failingDownload();
    assert.match(out.content[0].text, /Validation errors:/);
    assert.match(out.content[0].text, /"title"/);
  } finally {
    restore();
  }
});

test('grc_documents_read download: validation_failed with no details renders no extra text (matches gateway)', async () => {
  const restore = stubFailure(422, { detail: 'boom', code: 'validation_failed' });
  try {
    const out = await failingDownload();
    assert.equal(
      out.content[0].text,
      `Document download failed: HTTP 422: boom [GET /api/v2/documents/${DOC}/download]`,
    );
  } finally {
    restore();
  }
});

test('grc_documents_read download: an unrecognized-but-defined code hits the unknown-code floor', async () => {
  const restore = stubFailure(500, { detail: 'boom', code: 'some_future_code' });
  try {
    const out = await failingDownload();
    assert.match(
      out.content[0].text,
      /This is an unrecognized backend error code \("some_future_code"\) — do not assume it's retryable; check the FortMesa app for the current state\./,
    );
  } finally {
    restore();
  }
});

test('grc_documents_read download: a 404 with no code gets the "Record not found" floor, not the unknown-code floor', async () => {
  const restore = stubFailure(404, { detail: 'not found' });
  try {
    const out = await failingDownload();
    assert.match(out.content[0].text, /Record not found in this scope\. IDs are scope-local/);
    assert.equal(/unrecognized backend error code/.test(out.content[0].text), false);
  } finally {
    restore();
  }
});

test('grc_documents_read download: a plain error body with no code and no 404 status appends nothing', async () => {
  const restore = stubFailure(500, { detail: 'server exploded' });
  try {
    const out = await failingDownload();
    assert.match(out.content[0].text, /^Document download failed: HTTP 500: server exploded/);
    assert.equal(/unrecognized backend error code/.test(out.content[0].text), false);
    assert.equal(/Record not found/.test(out.content[0].text), false);
  } finally {
    restore();
  }
});

// -- the relayed methods are decorated by the same catch blocks -------------

test('grc_documents_delete: a hint is appended to a failure raised by the RELAY', async () => {
  // delete is relayed outright, so the gateway raises the error. The catch
  // block still has to decorate it, or relaying would quietly drop every hint.
  const reg = buildRegistry(() =>
    Promise.reject(new ApiError('HTTP 403: nope [DELETE /api/v2/documents/doc-1]', 403, 'role_required')),
  );
  const out = await reg.call('grc_documents_delete', { scopeId: SCOPE, documentId: DOC });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /^Document delete failed: HTTP 403: nope/);
  assert.match(out.content[0].text, /requires a scope role/);
});

test('grc_documents_read list: a relayed read failure is decorated too', async () => {
  const reg = buildRegistry(() =>
    Promise.reject(new ApiError('HTTP 422: boom [GET /api/v2/documents]', 422, 'invalid_rrule')),
  );
  const out = await reg.call('grc_documents_read', { method: 'list', scopeId: SCOPE });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /^Document list failed: HTTP 422: boom/);
  assert.match(out.content[0].text, /INTERVAL is invalid/);
});

test('grc_documents_write update: a relayed write failure is decorated too', async () => {
  const reg = buildRegistry(() =>
    Promise.reject(new ApiError('HTTP 403: nope [PATCH /api/v2/documents/doc-1]', 403, 'role_required')),
  );
  const out = await reg.call('grc_documents_write', {
    method: 'update',
    scopeId: SCOPE,
    documentId: DOC,
    title: 'New',
  });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /^Document update failed: HTTP 403: nope/);
  assert.match(out.content[0].text, /requires a scope role/);
});

// -- apiErrorCode/apiErrorStatus/apiErrorDetails: non-ApiError inputs are safe --

test('apiErrorCode/apiErrorStatus/apiErrorDetails: return undefined for a non-ApiError', () => {
  const plain = new Error('plain');
  assert.equal(apiErrorCode(plain), undefined);
  assert.equal(apiErrorStatus(plain), undefined);
  assert.equal(apiErrorDetails(plain), undefined);
});
