// Unit tests for grc_documents_write (src/local-mcp/tools/documents.ts).
//
// Run against the BUILT output, same convention as the registry tests:
//   yarn build && yarn node --test test/local-mcp/documents-write.test.mjs
//
// Covers the defects reported by the blank-persona MCP file-transfer test
// (RESULT-blank-persona-mcp-files.md):
//
//   D1 — `replaceFile` was emitted into the JSON Schema's `required` list while
//        also declaring `"default": false`. A client that validates before
//        sending refuses the call outright.
//   D3 — `replaceFile` is dead on the server: fmweb-be threads it from
//        document.controller.ts:519 into uploadDocument() and NEVER reads it
//        (document.service.ts:645-652 dedupes on gridfsFileName/title + scope
//        unconditionally). `replaceFile:false` therefore did NOT create a
//        second document; it appended a version to the first one.
//   D4 — the documented upload response ({id,title,fileSize,createdAt}) matched
//        neither the real response (docName, no fileSize, empty fileVersions)
//        nor the sibling read tools, which return `title`.
//   D5/D2 — grc_documents_delete must not mention an `archive` method on
//        grc_documents_write; no such method exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolRegistry } from '../../dist/local-mcp/tools/registry.js';
import { registerDocumentTools } from '../../dist/local-mcp/tools/documents.js';
import { ScopeLock } from '../../dist/shared/scope-lock.js';
import { setApiCredentials } from '../../dist/shared/api-client.js';

const SCOPE = '5da7314e388a0c6302e1f776';

/**
 * @param relay stand-in for the gateway. Rejects by default so a method that
 * relays where the test meant it to run locally fails loudly.
 */
function buildRegistry(relay = () => Promise.reject(new Error('unexpected relay to the gateway'))) {
  const reg = new LocalToolRegistry();
  registerDocumentTools(reg, () => ScopeLock.unlocked(), relay);
  return reg;
}

/** A relay that records what it was handed and answers with `result`. */
function recordingRelay(result = { ok: true }) {
  const calls = [];
  const relay = (toolName, args) => {
    calls.push({ toolName, args });
    return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  };
  relay.calls = calls;
  return relay;
}

function defOf(name) {
  return buildRegistry()
    .listDefs()
    .find((d) => d.name === name);
}

/** Parse the JSON payload out of a toolResult()/toolError() envelope. */
function payload(res) {
  assert.equal(res.isError, undefined, `tool returned an error: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
}

/**
 * Install a fake global fetch. `plan.upload` is the POST body the API returns;
 * `plan.getSequence` is consumed one entry per GET. The post-upload version readback
 * reads GET /api/v2/documents/{id}, so each entry is a DOCUMENT, not a list: fmweb-be
 * returns `fileVersions` only from the detail mapper now, never from the list.
 * Every request is recorded on `calls`.
 */
function stubFetch(plan) {
  const calls = [];
  const original = globalThis.fetch;
  let listIdx = 0;
  globalThis.fetch = async (url, config = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: config.method ?? 'GET', requestBody: config.body });
    let body;
    if ((config.method ?? 'GET') === 'POST') {
      body = plan.upload;
    } else {
      body = plan.getSequence[Math.min(listIdx, plan.getSequence.length - 1)];
      listIdx += 1;
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Pulls the multipart `filename="..."` off the "file" field of a raw upload body. */
function multipartFileName(requestBody) {
  const text = Buffer.isBuffer(requestBody) ? requestBody.toString('latin1') : String(requestBody);
  const match = /name="file";\s*filename="([^"]*)"/.exec(text);
  return match ? match[1] : undefined;
}

async function withTempFile(bytes, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fmmcp-doc-'));
  const path = join(dir, 'evidence.txt');
  await writeFile(path, Buffer.alloc(bytes, 0x61));
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

setApiCredentials('test-token-not-a-real-credential', 'http://api.test.invalid');

// ── D1/D3: the parameter is gone from the tool surface ──────────────────────

test('grc_documents_write: replaceFile is absent from the input schema', () => {
  const def = defOf('grc_documents_write');
  assert.ok(def, 'grc_documents_write must be registered');
  assert.equal(
    Object.hasOwn(def.inputSchema.properties, 'replaceFile'),
    false,
    'replaceFile must not be advertised — fmweb-be never reads it (document.service.ts:645-652)',
  );
  assert.equal(
    (def.inputSchema.required ?? []).includes('replaceFile'),
    false,
    'replaceFile must not be a required field',
  );
});

test('grc_documents_write: no schema property is both required and defaulted', () => {
  const def = defOf('grc_documents_write');
  for (const name of def.inputSchema.required ?? []) {
    const prop = def.inputSchema.properties[name] ?? {};
    assert.equal(
      Object.hasOwn(prop, 'default'),
      false,
      `"${name}" is in required[] AND declares a default — a validating client cannot satisfy that`,
    );
  }
});

test('grc_documents_write upload: a caller-supplied replaceFile cannot reach the API', async () => {
  const stub = stubFetch({
    upload: { id: 'doc-1', docName: 'evidence.txt', createdAt: 'x', fileVersions: ['v1'] },
    getSequence: [{ id: 'doc-1', fileVersions: ['v1'] }],
  });
  try {
    await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', {
        method: 'upload',
        scopeId: SCOPE,
        filePath: path,
        replaceFile: true,
      }),
    );
    const post = stub.calls.find((c) => c.method === 'POST');
    assert.equal(
      post.url.searchParams.get('replaceFile'),
      'false',
      'the removed parameter must be inert: a caller passing true must not change the request',
    );
  } finally {
    stub.restore();
  }
});

// ── D3: the description tells the truth about de-duplication ────────────────

test('grc_documents_write: description states the same-filename-adds-a-version rule', () => {
  const def = defOf('grc_documents_write');
  assert.match(
    def.description,
    /same filename in the same scope adds a version to the existing document/,
    'the real BE behaviour must be stated verbatim',
  );
  assert.equal(/replaceFile/.test(def.description), false, 'no residual mention of the removed parameter');
});

// ── D4: the documented response shape matches the real one ──────────────────

test('grc_documents_write: description documents the corrected upload response shape', () => {
  const def = defOf('grc_documents_write');
  for (const key of ['"id"', '"title"', '"fileSize"', '"createdAt"', '"versionCount"']) {
    assert.ok(def.description.includes(key), `upload response shape must document ${key}`);
  }
});

test('grc_documents_write upload: returns {id,title,fileSize,createdAt,versionCount} and nothing else', async () => {
  const upload = {
    id: 'doc-1',
    docName: 'evidence.txt',
    createdAt: '2026-09-04T00:00:00.000Z',
    fileVersions: [],
    documentFormat: 'plain',
  };
  const fetched = { id: 'doc-1', docName: 'evidence.txt', fileVersions: ['v1', 'v2'] };
  const stub = stubFetch({ upload, getSequence: [fetched] });
  try {
    const out = await withTempFile(1234, (path) =>
      buildRegistry().call('grc_documents_write', { method: 'upload', scopeId: SCOPE, filePath: path }),
    );
    const body = payload(out);
    assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'fileSize', 'id', 'title', 'versionCount']);
    assert.equal(body.id, 'doc-1');
    assert.equal(body.title, 'evidence.txt', 'docName must be mapped to title, as list/get already do');
    assert.equal(body.fileSize, 1234, 'fileSize is computed locally — the BE never returns one');
    assert.equal(body.createdAt, '2026-09-04T00:00:00.000Z');
    assert.equal(body.versionCount, 2, 'versionCount comes from the short post-upload poll');
  } finally {
    stub.restore();
  }
});

test('grc_documents_write upload: still sends the BE-required replaceFile=false query param', async () => {
  const stub = stubFetch({
    upload: { id: 'doc-1', docName: 'evidence.txt', createdAt: 'x', fileVersions: ['v1'] },
    getSequence: [{ id: 'doc-1', fileVersions: ['v1'] }],
  });
  try {
    await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', { method: 'upload', scopeId: SCOPE, filePath: path }),
    );
    const post = stub.calls.find((c) => c.method === 'POST');
    assert.ok(post, 'an upload POST must be issued');
    assert.equal(
      post.url.searchParams.get('replaceFile'),
      'false',
      'fmweb-be declares replaceFile required:true at document.controller.ts:519 — omitting it 422s',
    );
  } finally {
    stub.restore();
  }
});

test('grc_documents_write upload: versionCount is 0, not a hang, when versions never land', async () => {
  const stub = stubFetch({
    upload: { id: 'doc-1', docName: 'evidence.txt', createdAt: 'x', fileVersions: [] },
    getSequence: [{ id: 'doc-1', fileVersions: [] }],
  });
  try {
    const started = Date.now();
    const out = await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', { method: 'upload', scopeId: SCOPE, filePath: path }),
    );
    const elapsed = Date.now() - started;
    assert.equal(payload(out).versionCount, 0);
    assert.ok(elapsed < 5000, `the poll must be bounded (~2s); took ${elapsed}ms`);
  } finally {
    stub.restore();
  }
});

test('grc_documents_write upload: a failing version poll does not fail the upload', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, config = {}) => {
    if ((config.method ?? 'GET') === 'POST') {
      return new Response(JSON.stringify({ id: 'doc-1', docName: 'evidence.txt', createdAt: 'x' }), { status: 200 });
    }
    return new Response('boom', { status: 500 });
  };
  try {
    const out = await withTempFile(7, (path) =>
      buildRegistry().call('grc_documents_write', { method: 'upload', scopeId: SCOPE, filePath: path }),
    );
    const body = payload(out);
    assert.equal(body.id, 'doc-1');
    assert.equal(body.versionCount, 0, 'the upload itself succeeded; only the version readback failed');
  } finally {
    globalThis.fetch = original;
  }
});

// -- update: relayed to the gateway, arguments intact --------------------

test('grc_documents_write update: is relayed to the gateway, not handled here', async () => {
  // update used to PATCH the API directly. It is the gateway's now: this
  // process keeps only the two methods that need a filesystem. What still has
  // to hold is that every argument reaches the gateway unchanged.
  const relay = recordingRelay({ id: 'doc-1', title: 'New' });
  const out = await buildRegistry(relay).call('grc_documents_write', {
    method: 'update',
    scopeId: SCOPE,
    documentId: 'doc-1',
    title: 'New',
    description: 'Desc',
  });
  assert.equal(payload(out).id, 'doc-1');
  assert.equal(relay.calls.length, 1);
  assert.equal(relay.calls[0].toolName, 'grc_documents_write');
  assert.deepEqual(relay.calls[0].args, {
    method: 'update',
    scopeId: SCOPE,
    documentId: 'doc-1',
    title: 'New',
    description: 'Desc',
  });
});

test('grc_documents_write update: omits absent optionals rather than sending undefined', async () => {
  // A key present with an undefined value serializes to JSON as a MISSING key
  // in some paths and a null in others. Omitting it is the only shape that
  // means the same thing everywhere.
  const relay = recordingRelay();
  await buildRegistry(relay).call('grc_documents_write', {
    method: 'update',
    scopeId: SCOPE,
    documentId: 'doc-1',
    title: 'New',
  });
  assert.deepEqual(relay.calls[0].args, { method: 'update', scopeId: SCOPE, documentId: 'doc-1', title: 'New' });
  assert.equal('description' in relay.calls[0].args, false);
});

// ── D5/D2: no phantom archive method anywhere on the surface ────────────────

test('document tools: no stale archive precondition survives anywhere', () => {
  for (const def of buildRegistry().listDefs()) {
    const texts = [def.description, ...Object.values(def.inputSchema.properties).map((p) => p.description ?? '')];
    for (const text of texts) {
      assert.equal(/archived first/i.test(text), false, `${def.name}: stale archive precondition`);
      assert.equal(/use `?grc_documents_write`? archive/i.test(text), false, `${def.name}: phantom archive method`);
      assert.equal(/the archived document/i.test(text), false, `${def.name}: implies an archive step`);
    }
  }
});

test('grc_documents_delete: description carries the corrected two-phase text', () => {
  const def = defOf('grc_documents_delete');
  assert.match(def.description, /There is NO separate archive step/);
  assert.match(def.description, /FIRST call soft-deletes/);
  assert.match(def.description, /SECOND call on the same documentId permanently erases/);
});

test('grc_documents_write: method enum is exactly upload|upload_url|upload_status|update', () => {
  const def = defOf('grc_documents_write');
  assert.deepEqual(def.inputSchema.properties.method.enum, ['upload', 'upload_url', 'upload_status', 'update']);
});

// The gateway has no filesystem, so it publishes only the URL-based methods. This proxy
// publishes those AND the path-based ones, which is what makes it safe for tools/list to
// shadow the gateway's copy: local is a superset, so nothing is lost.
test('grc_documents_write: carries every method the gateway publishes', () => {
  const def = defOf('grc_documents_write');
  for (const method of ['upload_url', 'upload_status', 'update']) {
    assert.ok(def.inputSchema.properties.method.enum.includes(method), `missing gateway method ${method}`);
  }
});

test('grc_documents_read: carries every method the gateway publishes', () => {
  const def = defOf('grc_documents_read');
  for (const method of ['list', 'get', 'download_url', 'generate']) {
    assert.ok(def.inputSchema.properties.method.enum.includes(method), `missing gateway method ${method}`);
  }
});

test("grc_documents_write update: the no-op guard is the gateway's, and the call still reaches it", async () => {
  // The "Pass title, description, or both" refusal lives in fmmcp-gw's
  // documents.ts. Keeping a second copy here is exactly the duplication the
  // relay refactor removed, so what this pins is that an update carrying
  // neither field is still HANDED OVER rather than silently swallowed.
  const relay = recordingRelay();
  await buildRegistry(relay).call('grc_documents_write', {
    method: 'update',
    scopeId: SCOPE,
    documentId: 'doc-1',
  });
  assert.deepEqual(relay.calls[0].args, { method: 'update', scopeId: SCOPE, documentId: 'doc-1' });
});

// ── MFDV-489: upload honours fileName instead of the local basename ─────────

test('grc_documents_write upload: MFDV-489 — provided fileName is used, not the local basename', async () => {
  const stub = stubFetch({
    upload: { id: 'doc-1', docName: 'fm-local-test-2026-09-11.txt', createdAt: 'x', fileVersions: ['v1'] },
    getSequence: [{ id: 'doc-1', fileVersions: ['v1'] }],
  });
  try {
    const out = await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', {
        method: 'upload',
        scopeId: SCOPE,
        filePath: path, // basename is always "evidence.txt" (withTempFile)
        fileName: 'fm-local-test-2026-09-11.txt',
      }),
    );
    const post = stub.calls.find((c) => c.method === 'POST');
    assert.equal(
      multipartFileName(post.requestBody),
      'fm-local-test-2026-09-11.txt',
      'the multipart field must carry fileName, not the local basename — fmweb-be stores ' +
        "multer's originalname verbatim (document.service.ts:847)",
    );
    assert.equal(payload(out).title, 'fm-local-test-2026-09-11.txt');
  } finally {
    stub.restore();
  }
});

test('grc_documents_write upload: absent fileName still falls back to the local basename', async () => {
  const stub = stubFetch({
    upload: { id: 'doc-1', docName: 'evidence.txt', createdAt: 'x', fileVersions: ['v1'] },
    getSequence: [{ id: 'doc-1', fileVersions: ['v1'] }],
  });
  try {
    await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', { method: 'upload', scopeId: SCOPE, filePath: path }),
    );
    const post = stub.calls.find((c) => c.method === 'POST');
    assert.equal(multipartFileName(post.requestBody), 'evidence.txt');
  } finally {
    stub.restore();
  }
});

test('grc_documents_write upload: a fileName containing a path separator is rejected before any request is sent', async () => {
  const stub = stubFetch({ upload: {}, getSequence: [{}] });
  try {
    const out = await withTempFile(10, (path) =>
      buildRegistry().call('grc_documents_write', {
        method: 'upload',
        scopeId: SCOPE,
        filePath: path,
        fileName: '../escape.txt',
      }),
    );
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /must be a plain file name, not a path/);
    assert.equal(stub.calls.length, 0, 'no request should be issued once fileName fails validation');
  } finally {
    stub.restore();
  }
});

test('grc_documents_write: schema documents fileName for upload, not only upload_url', () => {
  const def = defOf('grc_documents_write');
  const desc = def.inputSchema.properties.fileName.description;
  assert.match(desc, /optional for upload/);
});
