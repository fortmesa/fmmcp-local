// Unit tests for the pure, vscode-free status-bar text projector
// (`statusBarSummaryFor`) and tooltip formatter (`scopeListTooltip`) in
// `src/extension/status-bar.ts` — PO 2026-09-09: the bar collapsed from
// listing every accessible scope to one of five states.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeListTooltip, statusBarSummaryFor } from '../../dist/registry/status-bar-summary.js';

test('not signed in -> "Not signed-in", regardless of scope count', () => {
  assert.equal(statusBarSummaryFor({ signedIn: false, mode: 'single', scopes: [] }), 'Not signed-in');
  assert.equal(statusBarSummaryFor({ signedIn: false, mode: 'single', scopes: ['barsoommsp'] }), 'Not signed-in');
  assert.equal(statusBarSummaryFor({ signedIn: false, mode: 'multi', scopes: ['a', 'b', 'c'] }), 'Not signed-in');
  assert.equal(statusBarSummaryFor({ signedIn: false, mode: 'unlocked', scopes: [] }), 'Not signed-in');
});

test('signed in + exactly one accessible scope -> the scope name', () => {
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'single', scopes: ['barsoommsp'] }), 'barsoommsp');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'multi', scopes: ['sandbox-a'] }), 'sandbox-a');
});

test('signed in + more than one accessible scope -> "Connected"', () => {
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'multi', scopes: ['a', 'b'] }), 'Connected');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'multi', scopes: ['a', 'b', 'c', 'd'] }), 'Connected');
});

test('signed in + Run unlocked mode -> "Connected", even with scopes present', () => {
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'unlocked', scopes: [] }), 'Connected');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'unlocked', scopes: ['a'] }), 'Connected');
});

test('signed in + zero accessible scopes (locked mode) -> "Connected · no scopes"', () => {
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'single', scopes: [] }), 'Connected · no scopes');
  assert.equal(statusBarSummaryFor({ signedIn: true, mode: 'multi', scopes: [] }), 'Connected · no scopes');
});

test('scopeListTooltip: empty list -> undefined', () => {
  assert.equal(scopeListTooltip([]), undefined);
});

test('scopeListTooltip: short list -> comma-joined, no truncation', () => {
  assert.equal(scopeListTooltip(['a', 'b', 'c']), 'a, b, c');
});

test('scopeListTooltip: exactly 10 -> no truncation', () => {
  const scopes = Array.from({ length: 10 }, (_, i) => `s${String(i)}`);
  assert.equal(scopeListTooltip(scopes), scopes.join(', '));
});

test('scopeListTooltip: 12 -> truncated to first 10 with "+2 more"', () => {
  const scopes = Array.from({ length: 12 }, (_, i) => `s${String(i)}`);
  const result = scopeListTooltip(scopes);
  assert.equal(result, `${scopes.slice(0, 10).join(', ')} (+2 more)`);
});
