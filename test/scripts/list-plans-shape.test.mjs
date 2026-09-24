import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListPlansResult } from '../../scripts/lib/list-plans-shape.mjs';

test('normalizeListPlansResult accepts a legacy bare array', () => {
  const legacy = [{ _id: 'p1' }, { _id: 'p2' }];
  assert.deepEqual(normalizeListPlansResult(legacy), legacy);
});

test('normalizeListPlansResult accepts the new { plans, hiddenCount, note } shape', () => {
  const modern = { plans: [{ _id: 'p1', active: true }], hiddenCount: 2, note: 'some hidden' };
  assert.deepEqual(normalizeListPlansResult(modern), modern.plans);
});

test('normalizeListPlansResult returns null for neither shape', () => {
  assert.equal(normalizeListPlansResult({ foo: 'bar' }), null);
  assert.equal(normalizeListPlansResult(null), null);
  assert.equal(normalizeListPlansResult(undefined), null);
});
