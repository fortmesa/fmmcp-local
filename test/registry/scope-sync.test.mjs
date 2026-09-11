// The auto-apply sync state machine (PO, 2026-09-08, after testing 0.7.4:
// "I think we should auto-apply but perhaps adopt a sync approach. Similar to
// google's undo button … Are we worried about storms?").
//
// The two properties this file exists to hold are the two ways a debounced
// auto-save fails, and neither is observable from a webview `<script>`:
//
//   STORM       — N rapid clicks must produce ONE write, and never two in
//                 flight at once.
//   LOST CLICK  — a click made while a write is out must still reach disk.
//
// Both are asserted here by DRIVING the machine, not by reading its source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialSyncState,
  syncTransition,
  syncAffordance,
  isSyncInProgress,
  SYNC_DEBOUNCE_MS,
  SYNC_QUIET_MS,
} from '../../dist/registry/scope-sync.js';

/**
 * A tiny driver: feeds events in order, counting the writes the machine asked
 * for. That count IS the storm assertion.
 */
function drive(events, from = initialSyncState) {
  let state = from;
  let writes = 0;
  let baselineCaptures = 0;
  let restores = 0;
  for (const event of events) {
    const step = syncTransition(state, typeof event === 'string' ? { type: event } : event);
    state = step.state;
    if (step.startWrite) writes += 1;
    if (step.captureBaseline) baselineCaptures += 1;
    if (step.restoreBaseline) restores += 1;
  }
  return { state, writes, baselineCaptures, restores };
}

test('the debounce is disclosed, not guessed: both timings are exported constants', () => {
  assert.equal(typeof SYNC_DEBOUNCE_MS, 'number');
  assert.ok(SYNC_DEBOUNCE_MS >= 1500 && SYNC_DEBOUNCE_MS <= 3000, 'the PO-sanctioned window');
  assert.ok(SYNC_QUIET_MS > 0);
});

test('a single edit: idle -> pending -> applying -> saved -> idle, with exactly one write', () => {
  const { state: pending } = drive(['edit']);
  assert.equal(pending.phase, 'pending');
  assert.equal(pending.debounceArmed, true);
  assert.equal(pending.writeInFlight, false);

  const { state: applying, writes } = drive(['edit', 'debounceElapsed']);
  assert.equal(applying.phase, 'applying');
  assert.equal(applying.writeInFlight, true);
  assert.equal(writes, 1);

  const { state: saved } = drive(['edit', 'debounceElapsed', 'writeOk']);
  assert.equal(saved.phase, 'saved');
  assert.equal(saved.writeInFlight, false);

  const { state: idle } = drive(['edit', 'debounceElapsed', 'writeOk', 'quietElapsed']);
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.undoArmed, false, 'the burst has retired, and Undo with it');
});

// ── STORM ────────────────────────────────────────────────────────────────

test('STORM: twenty rapid clicks coalesce into exactly ONE write', () => {
  const burst = Array.from({ length: 20 }, () => 'edit');
  const { state, writes } = drive([...burst, 'debounceElapsed']);
  assert.equal(writes, 1, 'every edit re-arms the single timer; only the last one fires');
  assert.equal(state.phase, 'applying');
});

test('STORM: never two writes in flight, even when the debounce fires mid-write', () => {
  // edit -> write out -> edit -> that debounce fires while the first write is
  // still outstanding. The second must be QUEUED, not launched.
  const { state, writes } = drive(['edit', 'debounceElapsed', 'edit', 'debounceElapsed']);
  assert.equal(writes, 1, 'the second write must not start while the first is in flight');
  assert.equal(state.writeInFlight, true);
  assert.equal(state.queued, true);
  assert.equal(state.phase, 'pending');

  // …and it goes the moment the first clears.
  const after = drive(['edit', 'debounceElapsed', 'edit', 'debounceElapsed', 'writeOk']);
  assert.equal(after.writes, 2);
  assert.equal(after.state.phase, 'applying');
  assert.equal(after.state.queued, false);
});

// ── LOST CLICK ───────────────────────────────────────────────────────────

test('LOST CLICK: an edit during a write leaves a timer armed, so the final draft always reaches disk', () => {
  const mid = drive(['edit', 'debounceElapsed', 'edit']);
  assert.equal(mid.state.phase, 'pending', 'the machine goes BACK to pending — the click is not swallowed');
  assert.equal(mid.state.debounceArmed, true, 'a timer is armed, so this draft will be written');
  assert.equal(mid.state.writeInFlight, true, 'and the in-flight write is NOT cancelled — those bytes are gone');

  // The in-flight write completing must not settle the machine to "saved":
  // there is newer intent outstanding.
  const settled = drive(['edit', 'debounceElapsed', 'edit', 'writeOk']);
  assert.equal(settled.state.phase, 'pending', 'a stale success must not report "Saved" over a newer edit');
  assert.equal(settled.state.debounceArmed, true);

  const finished = drive(['edit', 'debounceElapsed', 'edit', 'writeOk', 'debounceElapsed', 'writeOk']);
  assert.equal(finished.writes, 2);
  assert.equal(finished.state.phase, 'saved');
});

test('a failure of a write that has already been superseded stays quiet', () => {
  const { state } = drive(['edit', 'debounceElapsed', 'edit', 'writeFailed']);
  assert.equal(state.phase, 'pending', 'the user is about to hear about the NEW write, not the dead one');
});

// ── Failure and retry ────────────────────────────────────────────────────

test('a failed write keeps the draft and offers Retry — it never silently reverts', () => {
  const { state } = drive(['edit', 'debounceElapsed', 'writeFailed']);
  assert.equal(state.phase, 'failed');
  assert.equal(state.writeInFlight, false);

  const affordance = syncAffordance(state);
  assert.equal(affordance.message, "Couldn't save");
  assert.equal(affordance.action, 'retry');
  assert.equal(affordance.tone, 'error');

  const retried = drive(['edit', 'debounceElapsed', 'writeFailed', 'retry']);
  assert.equal(retried.writes, 2, 'Retry writes immediately — no second debounce on a deliberate click');
  assert.equal(retried.state.phase, 'applying');
});

test('editing after a failure resumes the burst rather than starting a new one', () => {
  const { state, baselineCaptures } = drive(['edit', 'debounceElapsed', 'writeFailed', 'edit']);
  assert.equal(state.phase, 'pending');
  assert.equal(baselineCaptures, 1, 'the undo baseline must still be where the burst began');
});

// ── Undo ─────────────────────────────────────────────────────────────────

test('Undo is armed for the whole burst and restores the baseline by WRITING it', () => {
  for (const prefix of [['edit'], ['edit', 'debounceElapsed'], ['edit', 'debounceElapsed', 'writeOk']]) {
    const { state } = drive(prefix);
    assert.equal(state.undoArmed, true, `Undo must be offered in phase "${state.phase}"`);
    assert.equal(syncAffordance(state).action, 'undo');
  }

  const undone = drive(['edit', 'debounceElapsed', 'writeOk', 'undo']);
  assert.equal(undone.restores, 1, 'the draft is put back to the baseline');
  assert.equal(undone.writes, 2, '…and that baseline is WRITTEN — disk no longer holds it');
  assert.equal(undone.state.phase, 'applying');
  assert.equal(undone.state.undoArmed, false, 'one-shot: no undo-of-undo ping-pong');
});

test('the undo baseline is captured ONCE per burst, so Undo reverts the whole change', () => {
  const { baselineCaptures } = drive(['edit', 'edit', 'edit', 'debounceElapsed', 'edit']);
  assert.equal(baselineCaptures, 1, 'a five-click burst must not leave Undo reverting only the last click');
});

test('a new burst after the quiet window captures a fresh baseline', () => {
  const { baselineCaptures } = drive(['edit', 'debounceElapsed', 'writeOk', 'quietElapsed', 'edit']);
  assert.equal(baselineCaptures, 2);
});

test('editing during the "Saved" window starts a new burst against the just-saved state', () => {
  const { baselineCaptures, state } = drive(['edit', 'debounceElapsed', 'writeOk', 'edit']);
  assert.equal(baselineCaptures, 2, 'the previous change LANDED — undoing past it would be a surprise');
  assert.equal(state.phase, 'pending');
});

test('Undo while a write is out is queued, not raced', () => {
  const { state, writes, restores } = drive(['edit', 'debounceElapsed', 'undo']);
  assert.equal(writes, 1, 'still exactly one write in flight');
  assert.equal(restores, 1);
  assert.equal(state.queued, true);
  assert.equal(state.phase, 'pending');
});

// ── Affordance and the consistency rule ──────────────────────────────────

test('the affordance takes no space at rest and says one thing per phase', () => {
  assert.deepEqual(syncAffordance(initialSyncState), {
    phase: 'idle',
    visible: false,
    message: '',
    tone: 'quiet',
  });
  assert.equal(syncAffordance(drive(['edit']).state).message, 'Applying…');
  assert.equal(syncAffordance(drive(['edit', 'debounceElapsed']).state).message, 'Applying…');
  assert.equal(syncAffordance(drive(['edit', 'debounceElapsed', 'writeOk']).state).message, 'Saved');
});

test('isSyncInProgress is true exactly in the phases whose affordance reads "Applying…"', () => {
  const phases = [
    [initialSyncState, false],
    [drive(['edit']).state, true],
    [drive(['edit', 'debounceElapsed']).state, true],
    [drive(['edit', 'debounceElapsed', 'writeOk']).state, false],
    [drive(['edit', 'debounceElapsed', 'writeFailed']).state, false],
  ];
  for (const [state, expected] of phases) {
    assert.equal(isSyncInProgress(state), expected, `phase "${state.phase}"`);
    if (expected) assert.equal(syncAffordance(state).message, 'Applying…');
    else assert.notEqual(syncAffordance(state).message, 'Applying…');
  }
});

// ── Totality ─────────────────────────────────────────────────────────────

test('every (phase, event) pair is total; stray late events are no-ops, not crashes', () => {
  const states = [
    initialSyncState,
    drive(['edit']).state,
    drive(['edit', 'debounceElapsed']).state,
    drive(['edit', 'debounceElapsed', 'writeOk']).state,
    drive(['edit', 'debounceElapsed', 'writeFailed']).state,
  ];
  const events = ['edit', 'debounceElapsed', 'writeOk', 'writeFailed', 'quietElapsed', 'undo', 'retry'];
  for (const state of states) {
    for (const type of events) {
      const step = syncTransition(state, { type });
      assert.ok(step.state, `${state.phase} + ${type} returned no state`);
      assert.equal(typeof step.state.phase, 'string');
      if (step.startWrite) {
        assert.equal(state.writeInFlight, false, `${state.phase} + ${type} started a SECOND concurrent write`);
      }
    }
  }
});

test('a stray writeOk with nothing in flight cannot fabricate a "Saved"', () => {
  assert.equal(syncTransition(initialSyncState, { type: 'writeOk' }).state.phase, 'idle');
  assert.equal(syncTransition(drive(['edit']).state, { type: 'writeOk' }).state.phase, 'pending');
});

test('a debounce timer that was superseded does nothing when it fires', () => {
  // `undo` disarms the debounce; a leftover timer must not launch a write.
  const state = drive(['edit', 'undo']).state;
  assert.equal(state.debounceArmed, false);
  assert.equal(syncTransition(state, { type: 'debounceElapsed' }).startWrite, false);
});

test('syncTransition never mutates the state it is given', () => {
  const before = drive(['edit']).state;
  const snapshot = { ...before };
  syncTransition(before, { type: 'debounceElapsed' });
  assert.deepEqual(before, snapshot);
});
