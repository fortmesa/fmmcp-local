// The Accessible scopes TABLE.
//
// Round 4 (PO, 2026-09-08): "redesign this to a tabular multi-select … with
// headline bulk-select/unselect control? consider all select states and
// workflow". Round 5, same day, after testing 0.7.4: "we need to avoid the
// apply button which may be scrolled offscreen … I think we should auto-apply
// but perhaps adopt a sync approach", plus a "Selected scopes" / "Run
// unlocked" mode toggle above the table.
//
// Every state the table can be in is decided by `projectScopeTable`, a pure
// function, precisely so it can be asserted here. The bug that motivated round
// 4 — "N of N scope(s) locked" rendered when all N were ACCESSIBLE — shipped
// because the equivalent logic lived inside a webview string literal in a
// `vscode`-importing module, where no test in this repo can reach it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectScopeTable,
  sameSelection,
  accessibleNames,
  FILTER_THRESHOLD,
} from '../../dist/registry/scope-table.js';
import { initialSyncState, syncTransition } from '../../dist/registry/scope-sync.js';

const ENTRIES = [
  { name: 'delta', id: 'd1' },
  { name: 'Alpha', id: 'a1' },
  { name: 'charlie', id: 'c1' },
  { name: 'bravo', id: 'b1' },
];

/** A "selected scopes" choice. */
const sel = (...scopes) => ({ mode: 'selected', scopes });
/** A "run unlocked" choice, optionally carrying a retained scope list. */
const unlocked = (...scopes) => ({ mode: 'unlocked', scopes });

/** The machine after one edit — i.e. `pending`, which is when rows may say "Applying…". */
const PENDING = syncTransition(initialSyncState, { type: 'edit' }).state;

test('rows are alphabetical and case-insensitive, NEVER grouped by state', () => {
  const view = projectScopeTable(ENTRIES, sel('delta'), sel('delta'));
  assert.deepEqual(
    view.rows.map((row) => row.name),
    ['Alpha', 'bravo', 'charlie', 'delta'],
  );
});

test('the count line reports the SAVED set, not the draft — an auto-apply surface must not promise early', () => {
  // Everything ticked in the draft, nothing saved yet.
  const view = projectScopeTable(ENTRIES, sel(), sel(...ENTRIES.map((e) => e.name)), '', PENDING);
  assert.equal(view.accessibleCount, 0, 'the count is about what the agent can do NOW');
  assert.equal(view.countLabel, '0 of 4 accessible');
  assert.doesNotMatch(view.countLabel, /lock/i, 'the word "locked" must never describe the accessible set');

  // …and once it lands, it counts all four.
  const landed = projectScopeTable(ENTRIES, sel(...ENTRIES.map((e) => e.name)), sel(...ENTRIES.map((e) => e.name)));
  assert.equal(landed.countLabel, '4 of 4 accessible');
});

test('the State cell reports the SAVED state, and says "Applying…" only while the machine agrees', () => {
  const draftChanges = projectScopeTable(ENTRIES, sel('Alpha'), sel('bravo'), '', PENDING);
  const pendingRows = Object.fromEntries(draftChanges.rows.map((row) => [row.name, row]));
  assert.equal(pendingRows.Alpha.chip, 'Applying…');
  assert.equal(pendingRows.Alpha.pending, true);
  assert.equal(pendingRows.bravo.chip, 'Applying…');
  assert.equal(pendingRows.charlie.chip, 'Inaccessible', 'a row the write does not touch keeps its state');
  assert.equal(pendingRows.charlie.pending, false);

  // THE consistency rule: a row may not show a phase the global affordance is
  // not in. Same drafts, machine idle -> no row says "Applying…".
  const idle = projectScopeTable(ENTRIES, sel('Alpha'), sel('bravo'), '', initialSyncState);
  const idleRows = Object.fromEntries(idle.rows.map((row) => [row.name, row]));
  assert.equal(idleRows.Alpha.chip, 'Accessible', 'saved state, because nothing is in flight');
  assert.equal(idleRows.bravo.chip, 'Inaccessible');
  assert.equal(idle.sync.visible, false);

  // Round 4's transition arrow is gone with the Apply button that justified it.
  for (const row of [...draftChanges.rows, ...idle.rows]) {
    assert.doesNotMatch(row.chip, /→/, 'no row renders a transition arrow any more');
  }
});

test('the checkbox reports the DRAFT while the chip reports the saved state — that split is the whole honesty of auto-apply', () => {
  const view = projectScopeTable(ENTRIES, sel('Alpha'), sel('Alpha', 'bravo'), '', PENDING);
  const bravo = view.rows.find((row) => row.name === 'bravo');
  assert.equal(bravo.draftAccessible, true, 'the click is answered instantly');
  assert.equal(bravo.savedAccessible, false, '…but the agent cannot act there yet');
});

test('bulk state is tri-state over the visible rows: none / some / all', () => {
  assert.equal(projectScopeTable(ENTRIES, sel(), sel()).bulk, 'none');
  assert.equal(projectScopeTable(ENTRIES, sel(), sel('bravo')).bulk, 'some');
  assert.equal(projectScopeTable(ENTRIES, sel(), sel('Alpha', 'bravo', 'charlie', 'delta')).bulk, 'all');
});

test('a filter narrows the rows, and the bulk checkbox follows the VISIBLE rows only', () => {
  // 'bravo' is selected and hidden; only 'charlie' is visible and unselected.
  const view = projectScopeTable(ENTRIES, sel('bravo'), sel('bravo'), 'char');
  assert.deepEqual(
    view.rows.map((row) => row.name),
    ['charlie'],
  );
  assert.equal(view.hidden, 3);
  assert.equal(view.bulk, 'none', 'the hidden selected row must not make the header look partly ticked');
  assert.equal(view.accessibleCount, 1, 'the count is about the whole selection, not the filtered view');
  assert.equal(view.countLabel, '1 of 4 accessible');
});

test('filtering is case-insensitive and matches a substring of the name', () => {
  assert.equal(projectScopeTable(ENTRIES, sel(), sel(), 'ALP').rows.length, 1);
  assert.equal(projectScopeTable(ENTRIES, sel(), sel(), 'ra').rows.length, 1); // bravo only
  assert.equal(projectScopeTable(ENTRIES, sel(), sel(), 'a').rows.length, 4); // every name contains an "a"
  assert.equal(projectScopeTable(ENTRIES, sel(), sel(), '   ').rows.length, 4, 'whitespace is not a filter');
});

// ── The mode toggle ──────────────────────────────────────────────────────

test('the toggle is a two-option radiogroup, labelled in SENTENCE case', () => {
  const view = projectScopeTable(ENTRIES, sel('Alpha'), sel('Alpha'));
  assert.deepEqual(
    view.modeOptions.map((option) => option.label),
    ['Selected scopes', 'Run unlocked'],
  );
  assert.equal(view.modeOptions.filter((option) => option.selected).length, 1, 'exactly one is checked');
  for (const option of view.modeOptions) {
    assert.notEqual(option.label, 'Selected Scopes', 'title case is explicitly wrong here');
  }
});

test('the toggle defaults to whatever is SAVED, in both directions', () => {
  assert.equal(projectScopeTable(ENTRIES, sel('Alpha'), sel('Alpha')).mode, 'selected');
  assert.equal(projectScopeTable(ENTRIES, unlocked(), unlocked()).mode, 'unlocked');
  assert.equal(projectScopeTable(ENTRIES, unlocked(), unlocked()).savedMode, 'unlocked');
});

test('in Run unlocked the table is HIDDEN and the count line stops counting', () => {
  const view = projectScopeTable(ENTRIES, unlocked(), unlocked());
  assert.equal(view.showTable, false, 'hidden, not disabled — a greyed grid of 40 checkboxes says nothing');
  assert.equal(view.countLabel, 'All scopes accessible');
  assert.match(view.modeHint, /including ones added later/, 'the hint must say the set is open-ended');
});

test('unlocked means every scope really is accessible — the two-meanings bug, asserted', () => {
  const view = projectScopeTable(ENTRIES, unlocked(), unlocked());
  assert.equal(
    view.rows.every((row) => row.savedAccessible),
    true,
  );
  assert.deepEqual(accessibleNames(unlocked(), ENTRIES).sort(), ['Alpha', 'bravo', 'charlie', 'delta']);
  assert.deepEqual(accessibleNames(sel('bravo'), ENTRIES), ['bravo']);
});

test('a mode change alone is a change; a retained scope list does not make two unlocked choices differ', () => {
  assert.equal(projectScopeTable(ENTRIES, sel('Alpha'), unlocked('Alpha')).changed, true);
  assert.equal(sameSelection(unlocked('Alpha'), unlocked()), true, 'scopes are ignored under unlocked');
  assert.equal(sameSelection(sel('Alpha', 'bravo'), sel('bravo', 'Alpha')), true, 'set equality, not array order');
  assert.equal(sameSelection(sel('Alpha'), unlocked('Alpha')), false);
});

test('switching to Run unlocked and back RETAINS the named scopes, so the round trip loses nothing', () => {
  const view = projectScopeTable(ENTRIES, sel('bravo'), unlocked('bravo'));
  assert.equal(view.showTable, false);
  // Toggling back projects the same set the user had.
  const back = projectScopeTable(ENTRIES, sel('bravo'), sel('bravo'));
  assert.equal(back.rows.find((row) => row.name === 'bravo').draftAccessible, true);
});

// ── Zero scopes ──────────────────────────────────────────────────────────

test('ZERO accessible scopes is a valid state, not a blocked one (PO: "it should be")', () => {
  const cleared = projectScopeTable(ENTRIES, sel('Alpha'), sel());
  assert.equal(cleared.changed, true);
  // Round 4's refusal is gone with the Apply button it belonged to.
  assert.equal('applyEnabled' in cleared, false, 'Apply no longer exists to be enabled');
  assert.equal('applyBlockedReason' in cleared, false, 'and nothing blocks an empty set any more');

  const saved = projectScopeTable(ENTRIES, sel(), sel());
  assert.equal(saved.countLabel, '0 of 4 accessible');
  assert.equal(
    saved.rows.every((row) => row.chip === 'Inaccessible'),
    true,
    'an empty saved set denies every scope — fail closed, and it says so',
  );
});

// ── Everything else ──────────────────────────────────────────────────────

test('the filter box appears only above the threshold, and bulk controls only above one scope', () => {
  const one = projectScopeTable([{ name: 'solo', id: 's1' }], sel('solo'), sel('solo'));
  assert.equal(one.showBulk, false, 'a one-scope region has nothing to bulk-select');
  assert.equal(one.showFilter, false);

  const many = Array.from({ length: FILTER_THRESHOLD + 1 }, (_, i) => ({ name: `scope-${i}`, id: `id-${i}` }));
  assert.equal(projectScopeTable(many, sel(), sel()).showFilter, true);
  assert.equal(projectScopeTable(many.slice(0, FILTER_THRESHOLD), sel(), sel()).showFilter, false);
});

test('an empty region is its own state, not a zero-row table', () => {
  const view = projectScopeTable([], sel(), sel());
  assert.equal(view.empty, true);
  assert.equal(view.total, 0);
  assert.equal(view.rows.length, 0);
  assert.equal(view.bulk, 'none');
});

test('projectScopeTable never mutates its inputs', () => {
  const entries = [...ENTRIES];
  const saved = sel('delta');
  const draft = sel('Alpha');
  projectScopeTable(entries, saved, draft, 'a', PENDING);
  assert.deepEqual(entries, ENTRIES);
  assert.deepEqual(saved.scopes, ['delta']);
  assert.deepEqual(draft.scopes, ['Alpha']);
});
