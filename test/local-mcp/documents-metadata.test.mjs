// Surface-metadata policy for the proxy's own tools.
//
// The proxy republishes the gateway's tools alongside these three, and its
// tools/list SHADOWS a gateway tool with the local one of the same name. So a
// disagreement about a title or a hint does not surface as a conflict: the
// local copy silently wins, and clients see a different contract depending on
// whether they reached the gateway directly or came through here.
//
// fmmcp-gw pins the same policy in src/tools/metadata.test.ts. These assertions
// are deliberately the same ones, so the two surfaces cannot drift apart
// without one of the suites going red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalToolRegistry } from '../../dist/local-mcp/tools/registry.js';
import { registerDocumentTools } from '../../dist/local-mcp/tools/documents.js';

function defs() {
  const registry = new LocalToolRegistry();
  registerDocumentTools(registry, () => ({ assertAuthorized: () => undefined }));
  return registry.listDefs();
}

void test('every local tool declares a non-empty title', () => {
  for (const tool of defs()) {
    assert.ok(typeof tool.title === 'string' && tool.title.length > 0, `${tool.name} is missing a top-level title`);
  }
});

void test('annotations.title mirrors the top-level title exactly', () => {
  // Clients on the 2025-06-18 spec prefer the top-level title; older clients
  // read annotations.title. Both must agree or the tool renders inconsistently.
  for (const tool of defs()) {
    assert.equal(tool.annotations.title, tool.title, `${tool.name}: annotations.title drifted from title`);
  }
});

void test('titles are unique across the local surface', () => {
  const titles = defs().map((t) => t.title);
  assert.equal(new Set(titles).size, titles.length, 'duplicate tool titles');
});

void test('every write tool is marked destructive', () => {
  // Policy: the spec's own test is "is this tool purely additive?". update
  // overwrites a title/description and delete erases, so neither is.
  for (const tool of defs()) {
    if (tool.annotations.readOnlyHint === true) continue;
    assert.equal(
      tool.annotations.destructiveHint,
      true,
      `${tool.name} is a write tool but claims destructiveHint: false`,
    );
  }
});

void test('every local tool declares open-world ingress', () => {
  for (const tool of defs()) {
    assert.equal(tool.annotations.openWorldHint, true, `${tool.name}: openWorldHint is not true`);
  }
});

void test('read tools are read-only and idempotent', () => {
  for (const tool of defs()) {
    if (!tool.name.endsWith('_read')) continue;
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} should be read-only`);
    assert.equal(tool.annotations.idempotentHint, true, `${tool.name} should be idempotent`);
  }
});

void test('the titles match the gateway copies these shadow', () => {
  // fmmcp-gw registers the same three names with these titles. A local tool that
  // shadows a gateway tool must not rename it out from under the client.
  const byName = new Map(defs().map((t) => [t.name, t.title]));
  assert.equal(byName.get('grc_documents_read'), 'Documents');
  assert.equal(byName.get('grc_documents_write'), 'Manage Documents');
  assert.equal(byName.get('grc_documents_delete'), 'Delete Document');
});

/**
 * Name-driven hints.
 *
 * The assertions above skip any tool claiming `readOnlyHint: true`, so a write
 * tool that wrongly claims to be read-only slips past all of them: the
 * destructive check skips it, and the read-only check only inspects names
 * ending `_read`. These derive the expectation from the NAME instead, so a
 * mis-annotation is caught by the thing it contradicts. Mirrors the same block
 * in fmmcp-gw's src/tools/metadata.test.ts.
 */
const MUTATING_METHOD = /^(create|update|delete|remove|archive|unarchive|upload|set|submit|add|link|unlink|complete)/;

void test('a tool named _write or _delete is never read-only', () => {
  const named = defs().filter((t) => /_(write|delete)$/.test(t.name));
  assert.ok(named.length > 0, 'positive control: the surface must contain some _write/_delete tools');

  for (const tool of named) {
    assert.notEqual(
      tool.annotations.readOnlyHint,
      true,
      `${tool.name}: name says it mutates but it claims readOnlyHint: true`,
    );
  }
});

void test('a tool named _write or _delete is destructive', () => {
  for (const tool of defs().filter((t) => /_(write|delete)$/.test(t.name))) {
    assert.equal(
      tool.annotations.destructiveHint,
      true,
      `${tool.name}: name says it mutates but destructiveHint is not true`,
    );
  }
});

void test('a tool offering a mutating method is never read-only', () => {
  // listDefs() emits JSON Schema, so the method vocabulary is a plain enum here.
  let checked = 0;
  for (const tool of defs()) {
    const methods = tool.inputSchema?.properties?.method?.enum ?? [];
    const mutating = methods.map(String).filter((m) => MUTATING_METHOD.test(m));
    if (mutating.length === 0) continue;
    checked += 1;
    assert.notEqual(
      tool.annotations.readOnlyHint,
      true,
      `${tool.name}: offers mutating method(s) ${mutating.join(', ')} but claims readOnlyHint: true`,
    );
  }
  assert.ok(checked > 0, 'positive control: some tool must expose a mutating method');
});
