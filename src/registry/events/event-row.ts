/**
 * The presentation shape the Event viewer's webviews render.
 *
 * Both views are painted from these — the extension host does every piece of
 * formatting and every redaction decision, and the webview does nothing but
 * place strings into cells. That split is deliberate: the webview is the one
 * place in this feature that can display text to a person, so it is given
 * nothing it could display that has not already been through
 * `summarize.ts`. There is no branch inside the webview that reads an
 * `EventRecord` field directly.
 *
 * `relative` is baked in rather than computed in the browser so the "3m ago"
 * rule lives in exactly one implementation; the host re-posts the rows on a
 * timer so they still age while the pane sits open.
 */
import type { EventRecord } from './event-record.js';
import { formatDuration, formatRelativeTime, outcomeGlyph, sidebarLine } from './summarize.js';

export interface EventRow {
  readonly id: string;
  /** `●` / `✓` / `✕` / `↻`. */
  readonly glyph: string;
  /** `documents · upload_url`, or just the family when there is no method. */
  readonly subject: string;
  /** `ok` | `error` | `running` — drives the row's theme colour, nothing else. */
  readonly outcome: string;
  /** The error class, when this row failed. Never an error message. */
  readonly errorClass?: string;
  /** `120ms` / `1.4s`, once settled. */
  readonly duration?: string;
  /** `now` / `4s ago` / `12m ago`. */
  readonly relative: string;
  /** Scope display name or short id — fullscreen column. */
  readonly scope?: string;
  /** `gateway` or `local` — fullscreen column. */
  readonly where?: string;
  /** The whole row as one line, for the row's hover title. */
  readonly line: string;
}

/** Project one record into its row. */
export function toEventRow(record: EventRecord, now: number = Date.now()): EventRow {
  const subject = record.method === undefined ? record.family : `${record.family} · ${record.method}`;
  const duration = formatDuration(record.durationMs);
  const where = record.relayed === undefined ? undefined : record.relayed ? 'gateway' : 'local';
  return {
    id: record.id,
    glyph: outcomeGlyph(record),
    subject,
    outcome: record.outcome,
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
    ...(duration === undefined ? {} : { duration }),
    relative: formatRelativeTime(record.ts, now),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
    ...(where === undefined ? {} : { where }),
    line: sidebarLine(record, now),
  };
}

/**
 * The most recent `limit` records as rows, **newest first** — the order both
 * views render, so a pane left open keeps the thing that just happened at the
 * top rather than scrolling it away.
 */
export function toEventRows(records: readonly EventRecord[], limit: number, now: number = Date.now()): EventRow[] {
  const recent = records.slice(Math.max(0, records.length - limit));
  return recent.map((record) => toEventRow(record, now)).reverse();
}
