// Sidebar ordering (PO, 2026-09-08): "reorder scope selector such that
// 'available scopes' appear first, followed by unavailable scopes in the
// primary sidebar (but keep alphabetic in the multi-select screen)."
//
// The comparator lives in `scope-display.ts` rather than in `tree-view.ts`
// for the same reason the row presentation does: nothing that imports
// `vscode` can be reached by a test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareScopeRows, sortScopeRows } from '../../dist/registry/scope-display.js';

const ROWS = [
  { name: 'delta', id: 'd' },
  { name: 'Alpha', id: 'a' },
  { name: 'charlie', id: 'c' },
  { name: 'bravo', id: 'b' },
];

const names = (rows) => rows.map((row) => row.name);

test('accessible scopes come first, alphabetical within each group', () => {
  const sorted = sortScopeRows('multi', ['delta', 'bravo'], ROWS);
  assert.deepEqual(names(sorted), ['bravo', 'delta', 'Alpha', 'charlie']);
});

test('unlocked mode makes every row accessible, so the order is plain alphabetical', () => {
  assert.deepEqual(names(sortScopeRows('unlocked', [], ROWS)), ['Alpha', 'bravo', 'charlie', 'delta']);
});

test('a locked mode with no scopes selected makes every row inaccessible — still alphabetical, no crash', () => {
  assert.deepEqual(names(sortScopeRows('single', [], ROWS)), ['Alpha', 'bravo', 'charlie', 'delta']);
});

test('sorting is case-insensitive on the name', () => {
  const sorted = sortScopeRows('multi', ['alpha'], [{ name: 'zulu' }, { name: 'Alpha' }, { name: 'alpha' }]);
  // 'alpha' is accessible; 'Alpha' is a DIFFERENT name and is not, so it
  // groups with 'zulu' below despite sorting next to 'alpha' by name.
  assert.equal(sorted[0].name, 'alpha');
  assert.deepEqual(names(sorted).slice(1), ['Alpha', 'zulu']);
});

test('the comparator is total and antisymmetric for names differing only in case', () => {
  // The DIRECTION is the platform collator's business; what must hold is that
  // the pair never compares equal (which would make the sort unstable across
  // engines) and that swapping the arguments flips the sign.
  const forward = compareScopeRows('unlocked', [], 'Alpha', 'alpha');
  const backward = compareScopeRows('unlocked', [], 'alpha', 'Alpha');
  assert.notEqual(forward, 0, 'names differing only in case must still order deterministically');
  assert.equal(Math.sign(forward), -Math.sign(backward));
  assert.equal(compareScopeRows('unlocked', [], 'alpha', 'alpha'), 0);
});

test('sortScopeRows returns a new array and leaves the input untouched', () => {
  const input = [...ROWS];
  const sorted = sortScopeRows('multi', ['delta'], input);
  assert.notEqual(sorted, input);
  assert.deepEqual(names(input), ['delta', 'Alpha', 'charlie', 'bravo']);
});
