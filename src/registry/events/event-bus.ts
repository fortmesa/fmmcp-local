/**
 * The Event viewer's in-memory ring buffer, and the subscription seam a
 * future log stream will attach to.
 *
 * ## Recall is deliberately limited to this IDE load
 *
 * There is no persistence here and there must not be one: no `globalState`,
 * no file, no `workspaceState`. The buffer is a plain object owned by
 * `activate()`, so a window reload or an extension restart constructs a new
 * empty one and the previous timeline is simply gone. That is the feature,
 * not a limitation — the pane shows tool families, scopes and outcomes, and
 * "what this machine's agent did last Tuesday" is not something a GRC tool
 * should leave lying in a VS Code state database for the next person who
 * opens the editor.
 *
 * So: **if you are ever asked to make the timeline survive a reload, that is
 * a new decision about data retention, not a caching improvement.**
 *
 * ## Why a hand-rolled emitter rather than `vscode.EventEmitter`
 *
 * Same reason as `registry/identity-events.ts`: this module is imported by
 * `src/registry/**` consumers and must stay `vscode`-free so a plain Node
 * unit test can assert the eviction and ordering rules. `subscribe()` returns
 * a structural `Disposable`, so it still drops straight into
 * `context.subscriptions`.
 *
 * ## The seam for later
 *
 * `subscribe()` is the whole extension point for the log stream the PO asked
 * us to build *towards*: a sink registers, receives every record as it is
 * published or settled, and does whatever it likes. Nothing in this repo
 * subscribes for that purpose today, and nothing here filters, searches or
 * exports.
 */
import type { EventRecord } from './event-record.js';

/** Rows the sidebar pane renders. */
export const SIDEBAR_EVENT_LIMIT = 30;

/** Rows the fullscreen panel renders — and the buffer's capacity. */
export const FULLSCREEN_EVENT_LIMIT = 200;

export type EventBusListener = (record: EventRecord) => void;

/** Structurally a `vscode.Disposable`. */
export interface EventBusSubscription {
  dispose(): void;
}

/** A partial update applied to an already-published record when it settles. */
export type EventPatch = Partial<Pick<EventRecord, 'outcome' | 'durationMs' | 'errorClass' | 'scope' | 'relayed'>>;

export class EventBus {
  private readonly records: EventRecord[] = [];
  private readonly listeners = new Set<EventBusListener>();

  constructor(private readonly capacity: number = FULLSCREEN_EVENT_LIMIT) {
    if (capacity < 1) throw new RangeError('EventBus capacity must be at least 1');
  }

  /**
   * Append a record, evicting the oldest once `capacity` is exceeded.
   *
   * Eviction is by age, never by kind: an errors-only or auth-only retention
   * rule would make the pane a different thing (a filtered log) and would make
   * "the last N" untrue.
   */
  publish(record: EventRecord): void {
    this.records.push(record);
    while (this.records.length > this.capacity) this.records.shift();
    this.emit(record);
  }

  /**
   * Settle a record already in the buffer — the `running` -> `ok`/`error`
   * transition, applied in place so the row does not duplicate.
   *
   * Returns `undefined` when the id is unknown, which happens legitimately:
   * a long-running call whose start has already been evicted by 200 newer
   * events settles into nothing, and dropping it is correct — reinserting it
   * would put a stale row at the head of the timeline.
   */
  settle(id: string, patch: EventPatch): EventRecord | undefined {
    // Found by VALUE rather than by index, so the record itself narrows the
    // type and no assertion is needed to spread it.
    const existing = this.records.find((record) => record.id === id);
    if (existing === undefined) return undefined;
    const updated: EventRecord = { ...existing, ...patch };
    this.records[this.records.indexOf(existing)] = updated;
    this.emit(updated);
    return updated;
  }

  /**
   * The most recent `limit` records, oldest first.
   *
   * Oldest-first because that is reading order for a timeline; the views
   * render newest at the top by reversing, which keeps "which end is newest"
   * a presentation choice rather than a buffer invariant.
   */
  snapshot(limit: number = this.capacity): readonly EventRecord[] {
    const take = Math.max(0, Math.min(limit, this.records.length));
    return this.records.slice(this.records.length - take);
  }

  /** How many records are held right now. */
  get size(): number {
    return this.records.length;
  }

  /** Drop every record. Used by the pane's own clear affordance and on dispose. */
  clear(): void {
    this.records.length = 0;
  }

  /**
   * Subscribe to every publish and settle. Dispose to unsubscribe.
   *
   * A listener that throws must not silence the others or break the producer
   * that published — the same isolation rule as `identity-events.ts`.
   */
  subscribe(listener: EventBusListener): EventBusSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Drop every listener and every record. */
  dispose(): void {
    this.listeners.clear();
    this.clear();
  }

  private emit(record: EventRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // A sink's failure is its own problem.
      }
    }
  }
}
