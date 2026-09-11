/**
 * The **Accessible scopes** table's projection — every visible state of the
 * multi-select surface (`extension/scope-select-panel.ts`) as a pure function
 * over plain data.
 *
 * PO, 2026-09-08: *"the multi-select select all box is confusing … can we
 * redesign this to a tabular multi-select more familiar to the user with
 * headline bulk-select/unselect control? consider all select states and
 * workflow here."*
 *
 * Why the projection lives here rather than in the panel's inline `<script>`.
 * The old panel computed its summary inside the webview, which is a string
 * literal in a `vscode`-importing module — unreachable by every test in this
 * repo. That is exactly how "N of N scope(s) locked" shipped: the count was
 * of the SELECTED (i.e. accessible) scopes, labelled with the word for their
 * opposite, and nothing could assert otherwise. So the panel is now a dumb
 * renderer: it posts `{ draft, filter }` to the host, the host projects with
 * this function against a cached scope list, and posts the view back. The
 * round trip is in-process and touches no network — the panel caches the
 * gateway's scope list and only refetches on open/refresh.
 *
 * VOCABULARY: **Accessible** (the agent may act in this scope) /
 * **Inaccessible**. See `scope-display.ts` for why "locked" is gone from
 * user-facing copy and why the on-disk `scopeLock` contract keeps its name.
 *
 * Round 5 (PO, 2026-09-08) made three changes worth stating because each
 * reverses a round-4 decision in this same file:
 *
 *  1. **Apply and Cancel are gone.** The panel auto-applies through the
 *     debounced state machine in `scope-sync.ts`. `applyEnabled` and
 *     `applyBlockedReason` went with them.
 *  2. **The count line and the State cell now render the SAVED state, the
 *     checkbox renders the DRAFT.** That split is the honesty of an
 *     auto-apply surface: the checkbox is your intent and must answer the
 *     click instantly; the count and the chip are what the agent will
 *     actually be allowed to do, and must not lie during the ~2 s in which
 *     the two disagree. A row whose write is outstanding reads `Applying…` —
 *     never round 4's `Accessible → Inaccessible` arrow, which described a
 *     transition that no longer needs a user decision.
 *  3. **A zero-scope selection is a valid saved state.** Nothing blocks it;
 *     `ScopeLock.lockedTo([])` denies every scope, which is exactly what
 *     "the agent may act nowhere" has to mean. The block was only ever in
 *     this projection.
 *
 * The **mode toggle** ("Selected scopes" / "Run unlocked") is projected here
 * too. In `unlocked` the table is HIDDEN rather than disabled: a disabled
 * grid of 40 checkboxes is a wall of noise stating something a one-line hint
 * says better.
 *
 * `vscode`-free on purpose (VSIX-PLAN.md §3.1).
 */
import {
  initialSyncState,
  isSyncInProgress,
  syncAffordance,
  type SyncAffordance,
  type SyncState,
} from './scope-sync.js';

/** One scope as the gateway reported it. */
export interface ScopeTableEntry {
  readonly name: string;
  readonly id: string;
}

/** The headline checkbox is tri-state over the VISIBLE rows — the rows a bulk action would touch. */
export type BulkCheckboxState = 'none' | 'some' | 'all';

/**
 * The two things the toggle at the top of the panel chooses between.
 *
 * `selected` covers the on-disk `single` and `multi` modes — from the user's
 * side they are one idea ("these named scopes"), and which of the two gets
 * persisted is a detail of how many were named. `unlocked` is the on-disk
 * `unlocked` mode unchanged: every scope this account is entitled to,
 * INCLUDING ones granted later, which is why it cannot be expressed as a
 * ticked list.
 */
export type ScopeSelectionMode = 'selected' | 'unlocked';

/** A whole accessible-set choice: the mode plus, for `selected`, the named scopes. */
export interface ScopeSelection {
  readonly mode: ScopeSelectionMode;
  readonly scopes: readonly string[];
}

export interface ScopeTableRow {
  readonly name: string;
  readonly id: string;
  /** Accessible in the SAVED configuration — what the agent can do right now. */
  readonly savedAccessible: boolean;
  /** Accessible in the user's draft — what the checkbox shows. */
  readonly draftAccessible: boolean;
  /** The State cell: `Accessible` / `Inaccessible`, or `Applying…` while this row's write is outstanding. */
  readonly chip: string;
  /** True when this row's draft differs from what is saved. */
  readonly pending: boolean;
}

/** One segment of the mode toggle (a radiogroup, so exactly one is `selected`). */
export interface ScopeModeOption {
  readonly value: ScopeSelectionMode;
  readonly label: string;
  readonly selected: boolean;
}

export interface ScopeTableView {
  /** The draft mode — what the toggle shows. */
  readonly mode: ScopeSelectionMode;
  /** The saved mode — what is in effect. */
  readonly savedMode: ScopeSelectionMode;
  readonly modeOptions: readonly ScopeModeOption[];
  /** One WWMD line under the toggle saying what the chosen mode means. */
  readonly modeHint: string;
  /** False in `unlocked`: the table is HIDDEN, not disabled. */
  readonly showTable: boolean;
  /** Visible rows: alphabetical (case-insensitive), filtered. NEVER grouped by state — a row that jumps group as you tick it is unusable. */
  readonly rows: readonly ScopeTableRow[];
  /** Every scope for this data region, filtered or not. */
  readonly total: number;
  /** Rows the filter is currently hiding. `0` when no filter is active. */
  readonly hidden: number;
  /** SAVED accessible count across ALL scopes — the count line reports reality, not intent. */
  readonly accessibleCount: number;
  readonly countLabel: string;
  readonly bulk: BulkCheckboxState;
  /** The filter box only earns its space on a long list. */
  readonly showFilter: boolean;
  /** A one-scope region has nothing to bulk-select or filter. */
  readonly showBulk: boolean;
  readonly empty: boolean;
  /** The draft differs from what is saved. */
  readonly changed: boolean;
  /** The single global sync affordance, right of the filter box. */
  readonly sync: SyncAffordance;
}

/** Above this many scopes the filter box is worth its space. */
export const FILTER_THRESHOLD = 12;

/** Hint copy for each mode. One idea, state first, no justification clause (WWMD). */
export const MODE_HINTS: Readonly<Record<ScopeSelectionMode, string>> = {
  selected: 'The agent can act only in the scopes you check.',
  unlocked: 'The agent can act in every scope you have access to, including ones added later.',
};

/** Toggle labels. Sentence case — "Selected scopes", never "Selected Scopes". */
export const MODE_LABELS: Readonly<Record<ScopeSelectionMode, string>> = {
  selected: 'Selected scopes',
  unlocked: 'Run unlocked',
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

/** Two selections are the same choice when the modes match and, for `selected`, the sets do. */
export function sameSelection(a: ScopeSelection, b: ScopeSelection): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode === 'unlocked' || sameSet(a.scopes, b.scopes);
}

/**
 * Which scopes a selection actually makes accessible.
 *
 * `unlocked` maps to EVERY name — not to the empty `scopeLock.scopes` array
 * it stores. Rendering those rows unticked while the sidebar calls them
 * accessible is precisely the two-meanings bug round 4 removed.
 */
export function accessibleNames(selection: ScopeSelection, entries: readonly ScopeTableEntry[]): string[] {
  return selection.mode === 'unlocked' ? entries.map((entry) => entry.name) : [...selection.scopes];
}

/**
 * Project the table.
 *
 * @param entries The gateway's scope list for the active data region.
 * @param saved   The accessible-set choice as SAVED — the count line and every State cell.
 * @param draft   The user's current choice — every checkbox and the toggle.
 * @param filter  Case-insensitive substring match on the scope name. Empty = no filter.
 * @param sync    The auto-apply machine's state (`scope-sync.ts`).
 */
export function projectScopeTable(
  entries: readonly ScopeTableEntry[],
  saved: ScopeSelection,
  draft: ScopeSelection,
  filter = '',
  sync: SyncState = initialSyncState,
): ScopeTableView {
  const savedSet = new Set(accessibleNames(saved, entries));
  const draftSet = new Set(accessibleNames(draft, entries));
  const inProgress = isSyncInProgress(sync);

  const sorted = [...entries].sort((a, b) => {
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return byName !== 0 ? byName : a.name.localeCompare(b.name);
  });

  const needle = filter.trim().toLowerCase();
  const visible = needle === '' ? sorted : sorted.filter((entry) => entry.name.toLowerCase().includes(needle));

  const rows = visible.map((entry) => {
    const savedAccessible = savedSet.has(entry.name);
    const draftAccessible = draftSet.has(entry.name);
    const pending = savedAccessible !== draftAccessible;
    return {
      name: entry.name,
      id: entry.id,
      savedAccessible,
      draftAccessible,
      // THE consistency rule between the two projections of the one state
      // machine: a row may say "Applying…" only while the global affordance
      // does. Otherwise it reports the SAVED state, because that is what the
      // agent can do right now.
      chip: pending && inProgress ? 'Applying…' : savedAccessible ? 'Accessible' : 'Inaccessible',
      pending,
    };
  });

  // Bulk state is over the VISIBLE rows, because that is what a bulk action
  // touches while a filter is on. With nothing visible there is nothing to
  // select, which reads as 'none'.
  const selectedVisible = rows.filter((row) => row.draftAccessible).length;
  const bulk: BulkCheckboxState =
    rows.length > 0 && selectedVisible === rows.length ? 'all' : selectedVisible === 0 ? 'none' : 'some';

  const accessibleCount = sorted.filter((entry) => savedSet.has(entry.name)).length;

  return {
    mode: draft.mode,
    savedMode: saved.mode,
    modeOptions: (['selected', 'unlocked'] as const).map((value) => ({
      value,
      label: MODE_LABELS[value],
      selected: draft.mode === value,
    })),
    modeHint: MODE_HINTS[draft.mode],
    showTable: draft.mode === 'selected',
    rows,
    total: sorted.length,
    hidden: sorted.length - visible.length,
    accessibleCount,
    // The count reports what is SAVED. In unlocked mode there is no count to
    // report — the set is open-ended by definition, since scopes granted
    // later join it.
    countLabel:
      saved.mode === 'unlocked'
        ? 'All scopes accessible'
        : `${String(accessibleCount)} of ${String(sorted.length)} accessible`,
    bulk,
    showFilter: sorted.length > FILTER_THRESHOLD,
    showBulk: sorted.length > 1,
    empty: sorted.length === 0,
    changed: !sameSelection(saved, draft),
    sync: syncAffordance(sync),
  };
}
