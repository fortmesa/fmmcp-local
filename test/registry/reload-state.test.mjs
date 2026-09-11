// Unit tests for src/local-mcp/reload-state.ts — the quarantine a failed hot
// reload puts the proxy into.
//
// Run against the BUILT output:
//   yarn build && yarn node --test test/registry/reload-state.test.mjs
//
// Defect covered: proxy.ts's reload() kept the PREVIOUS gateway client and
// scope lock when a reload failed, and cli.ts only logged it — so the user saw
// the new scope in Saferoom while the agent retained access to the old one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReloadState } from '../../dist/local-mcp/reload-state.js';

test('a fresh state serves normally', () => {
  const state = new ReloadState();
  assert.equal(state.isQuarantined, false);
  assert.equal(state.blockedReason, undefined);
});

test('a failed reload quarantines and explains itself without claiming an authorisation decision', () => {
  const state = new ReloadState();
  state.markFailed('connect ECONNREFUSED 127.0.0.1:1');
  assert.equal(state.isQuarantined, true);

  const reason = state.blockedReason;
  assert.ok(reason !== undefined, 'a quarantined state must produce a refusal message');
  assert.match(reason, /could not apply the last environment\/scope change/i);
  assert.match(
    reason,
    /rather than continue on the previous environment and scope/i,
    'must state that the stale binding is NOT being served',
  );
  assert.match(reason, /NOT an authorisation decision/i);
  assert.match(reason, /ECONNREFUSED/, 'must carry the underlying cause');
  assert.match(reason, /Saferoom sidebar/, 'must name the recovery action');
});

test('a successful reload clears the quarantine', () => {
  const state = new ReloadState();
  state.markFailed('boom');
  state.markSucceeded();
  assert.equal(state.isQuarantined, false);
  assert.equal(state.blockedReason, undefined);
});

test('a second failure replaces the first reason rather than accumulating', () => {
  const state = new ReloadState();
  state.markFailed('first');
  state.markFailed('second');
  const reason = state.blockedReason;
  assert.match(reason, /second/);
  assert.doesNotMatch(reason, /first/);
});
