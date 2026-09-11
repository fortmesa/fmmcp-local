/**
 * The **auto-apply sync state machine** for the Accessible scopes panel — the
 * whole of it, as a pure function over plain data.
 *
 * PO, 2026-09-08 (after testing 0.7.4): *"we need to avoid the apply button
 * which may be scrolled offscreen … I think we should auto-apply but perhaps
 * adopt a sync approach. Similar to google's undo button … Are we worried
 * about storms? If so add a 3-5 second delay with cancel/retry."*
 *
 * So round 4's `Apply`/`Cancel` pair is gone. Every edit writes by itself,
 * after a debounce, and the user's safety net is **Undo** rather than a
 * pre-commit review step.
 *
 * ## Why this file exists at all
 *
 * A debounced auto-save has exactly two classic failure modes, and both are
 * invisible in a webview `<script>` that no test in this repo can load (the
 * same structural argument as `scope-display.ts` and `scope-table.ts`):
 *
 *  1. **A storm.** Each click writes, each write hot-reloads every consumer.
 *  2. **A lost click.** An edit made while a write is in flight is clobbered
 *     when that write's completion re-seeds the UI from disk.
 *
 * Both are closed here, structurally rather than by care:
 *
 *  - **Storm**: at most ONE write is ever in flight (`writeInFlight` is a
 *    guard, not a label), and every edit re-arms the single debounce timer,
 *    so N rapid toggles coalesce into one write.
 *  - **Lost click**: an edit arriving during `applying` does NOT cancel the
 *    in-flight write — those bytes are already on their way to the
 *    filesystem — it moves the machine back to `pending` and re-arms the
 *    timer. Because a timer is ALWAYS armed after the last edit, the final
 *    draft always reaches disk. When the debounce fires while a write is
 *    still in flight, the follow-up is `queued` and starts the instant the
 *    flight clears.
 *
 * ## Cost being amortised
 *
 * Not the file write. `saveConfig` → `watchConfig` → `applyConfig`
 * (`extension/extension.ts`) refreshes three views, re-fires the MCP
 * provider's change event, and makes every running proxy re-read its scope
 * lock (`resolveEffectiveStartup`). That ripple is what must happen once per
 * burst instead of once per click.
 *
 * `vscode`-free on purpose (VSIX-PLAN.md §3.1).
 */

/**
 * How long after the last edit the write goes out.
 *
 * 2000 ms sits above a human's ~300-700 ms inter-click cadence inside one
 * intent burst ("select all, then untick three") and below the ~2.5-3 s at
 * which "did that take?" anxiety starts. The PO floated 3-5 s as the price of
 * a *cancel* window; we do not buy safety with delay, because Undo stays live
 * through the whole pending + applying + quiet window (~4 s) — the safety net
 * is the undo, not the wait. The delay is disclosed rather than hidden: the
 * affordance reads "Applying…" for its entire duration.
 */
export const SYNC_DEBOUNCE_MS = 2000;

/** How long "Saved" lingers before the affordance goes quiet. */
export const SYNC_QUIET_MS = 2000;

export type SyncPhase = 'idle' | 'pending' | 'applying' | 'saved' | 'failed';

export interface SyncState {
  readonly phase: SyncPhase;
  /** A debounce timer is running; it will deliver `debounceElapsed`. */
  readonly debounceArmed: boolean;
  /** A `saveConfig` call is outstanding. At most one, ever. */
  readonly writeInFlight: boolean;
  /** The debounce fired while a write was in flight: start the next one as soon as it clears. */
  readonly queued: boolean;
  /** An undo baseline is captured and the Undo action should be offered. */
  readonly undoArmed: boolean;
}

export const initialSyncState: SyncState = {
  phase: 'idle',
  debounceArmed: false,
  writeInFlight: false,
  queued: false,
  undoArmed: false,
};

export type SyncEvent =
  /** Any draft mutation: a row checkbox, a shift-click range, the tri-state header box, Select all, Clear, or the mode toggle. */
  | { readonly type: 'edit' }
  | { readonly type: 'debounceElapsed' }
  | { readonly type: 'writeOk' }
  | { readonly type: 'writeFailed' }
  | { readonly type: 'quietElapsed' }
  | { readonly type: 'undo' }
  | { readonly type: 'retry' };

/**
 * One transition, plus the side effects the caller must perform. Keeping the
 * effects in the return value (rather than letting the caller infer them from
 * the phase) is what makes "exactly one write per burst" assertable.
 */
export interface SyncStep {
  readonly state: SyncState;
  /** Call `saveConfig` with the current draft now. Never true while a write is already in flight. */
  readonly startWrite: boolean;
  /** Remember the saved set as the undo baseline — a new burst is beginning. */
  readonly captureBaseline: boolean;
  /** Restore the draft to the undo baseline before writing. */
  readonly restoreBaseline: boolean;
}

function step(
  state: SyncState,
  effects: Partial<Omit<SyncStep, 'state'>> = {},
  overrides: Partial<SyncState> = {},
): SyncStep {
  return {
    state: { ...state, ...overrides },
    startWrite: effects.startWrite ?? false,
    captureBaseline: effects.captureBaseline ?? false,
    restoreBaseline: effects.restoreBaseline ?? false,
  };
}

/**
 * Begin a write, or queue one when the single in-flight slot is taken.
 *
 * This is the one place that decides to call `saveConfig`, which is why the
 * "never more than one in flight" guarantee is a property of the machine
 * rather than a discipline the caller has to keep.
 */
function launch(state: SyncState, extra: Partial<Omit<SyncStep, 'state'>> = {}): SyncStep {
  if (state.writeInFlight) {
    return step(state, extra, { phase: 'pending', debounceArmed: false, queued: true });
  }
  return step(
    state,
    { ...extra, startWrite: true },
    {
      phase: 'applying',
      debounceArmed: false,
      writeInFlight: true,
      queued: false,
    },
  );
}

/** What a completed write settles to, honouring any edit that landed while it was out. */
function settle(state: SyncState, failedPhase: SyncPhase): SyncStep {
  const cleared: SyncState = { ...state, writeInFlight: false };

  // A newer write is already wanted: start it immediately and say nothing
  // about this one. Its outcome is about to be superseded either way.
  if (cleared.queued) {
    return launch({ ...cleared, queued: false });
  }

  // An edit arrived while the write was out and its timer is still running.
  // Stay in `pending`: the affordance already reads "Applying…", so there is
  // no flicker, and the follow-up write is what the user will hear about.
  if (cleared.debounceArmed) return step(cleared, {}, { phase: 'pending' });

  return step(cleared, {}, { phase: failedPhase });
}

/**
 * Advance the machine.
 *
 * Total: every (phase, event) pair returns a state. Events that cannot apply
 * in the current phase (a stray `retry` outside `failed`, a `debounceElapsed`
 * from a timer that was superseded) are no-ops rather than errors — timers
 * and webview messages both arrive late in practice.
 */
export function syncTransition(state: SyncState, event: SyncEvent): SyncStep {
  switch (event.type) {
    case 'edit':
      // Leaving a settled phase starts a new burst, so that is where the undo
      // baseline is captured. An edit in `pending`/`applying`/`failed` extends
      // the burst already running and must NOT move the baseline, or Undo
      // would only undo the last click of a multi-click change.
      return step(
        state,
        { captureBaseline: state.phase === 'idle' || state.phase === 'saved' },
        {
          phase: 'pending',
          debounceArmed: true,
          undoArmed: true,
        },
      );

    case 'debounceElapsed':
      if (!state.debounceArmed) return step(state);
      return launch({ ...state, debounceArmed: false });

    case 'writeOk':
      if (!state.writeInFlight) return step(state);
      return settle(state, 'saved');

    case 'writeFailed':
      if (!state.writeInFlight) return step(state);
      return settle(state, 'failed');

    case 'quietElapsed':
      if (state.phase !== 'saved') return step(state);
      return step(state, {}, { phase: 'idle', undoArmed: false });

    case 'undo':
      if (!state.undoArmed) return step(state);
      // Undo acts NOW rather than through the debounce — it is a deliberate
      // click on a disappearing affordance, not part of a burst. It disarms
      // itself: undoing is its own burst, and an undo-of-undo would be a
      // ping-pong with no stable meaning.
      return launch({ ...state, undoArmed: false }, { restoreBaseline: true });

    case 'retry':
      if (state.phase !== 'failed') return step(state);
      return launch(state);
  }
}

export interface SyncAffordance {
  readonly phase: SyncPhase;
  /** False in `idle`: the affordance takes no space at rest. */
  readonly visible: boolean;
  /** '' when not visible. */
  readonly message: string;
  readonly action?: 'undo' | 'retry';
  readonly actionLabel?: string;
  readonly tone: 'quiet' | 'error';
}

/**
 * The single global sync affordance, floated right of the filter box.
 *
 * It is global rather than per-row because a write covers the WHOLE
 * accessible set in one `saveConfig`, so Undo and Retry are operations on the
 * coalesced burst — a per-row Undo would either undo rows the user never
 * touched or split the write, reintroducing the storm.
 */
export function syncAffordance(state: SyncState): SyncAffordance {
  switch (state.phase) {
    case 'idle':
      return { phase: 'idle', visible: false, message: '', tone: 'quiet' };

    case 'pending':
    case 'applying':
      return {
        phase: state.phase,
        visible: true,
        message: 'Applying…',
        tone: 'quiet',
        ...(state.undoArmed ? { action: 'undo' as const, actionLabel: 'Undo' } : {}),
      };

    case 'saved':
      return {
        phase: 'saved',
        visible: true,
        message: 'Saved',
        tone: 'quiet',
        ...(state.undoArmed ? { action: 'undo' as const, actionLabel: 'Undo' } : {}),
      };

    case 'failed':
      return {
        phase: 'failed',
        visible: true,
        message: "Couldn't save",
        tone: 'error',
        action: 'retry',
        actionLabel: 'Retry',
      };
  }
}

/**
 * Is a write outstanding for the draft — i.e. should rows that differ from the
 * saved set read "Applying…"?
 *
 * THE consistency rule between the two projections of this one machine: a row
 * cell may show `Applying…` only while this is true, so it can never show a
 * phase the global affordance is not in.
 */
export function isSyncInProgress(state: SyncState): boolean {
  return state.phase === 'pending' || state.phase === 'applying';
}
