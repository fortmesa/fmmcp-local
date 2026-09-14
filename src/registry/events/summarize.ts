/**
 * Redaction and summarisation for the Event viewer — the module that decides
 * what a person is allowed to see about an MCP call.
 *
 * ## The rule, and why it is shaped this way
 *
 * Redaction here is **allowlist extraction**, never denylist stripping. We do
 * not take a request payload and remove the fields we recognise as sensitive;
 * we read a fixed handful of fields and ignore everything else in the object.
 * A denylist leaks the moment a new argument name appears (and every gateway
 * deploy can add one); an allowlist that only ever reads `name` and a
 * length-capped `method` cannot leak a field nobody anticipated, because it
 * never looks at it.
 *
 * Consequences worth stating plainly:
 *  - `summarizeToolCall` takes the arguments object and returns **two short
 *    tokens**. A bearer token, a workspace path, a document title or an email
 *    sitting anywhere in those arguments has no route into the output — not
 *    even under an argument literally named `method`, because the value must
 *    also pass {@link SAFE_TOKEN}'s 32-character cap.
 *  - `classifyError` takes an error and returns an {@link ErrorClass} from a
 *    closed set. The error's own message is read only to *classify*, and is
 *    never carried forward; a gateway error that quotes the request it
 *    rejected therefore cannot reach the pane.
 *
 * Kept `vscode`-free (same reasoning as `registry/scope-display.ts` and
 * `registry/identity-events.ts`): the property being asserted is a security
 * property, so it must be testable by a plain Node unit test rather than only
 * observable in a running extension host.
 */
import { isSafeToken, type ErrorClass, type EventRecord } from './event-record.js';

/** How the tool name decomposes for display. */
export interface ToolSummary {
  readonly family: string;
  readonly method?: string;
}

/**
 * Split an MCP tool name into `family · method`.
 *
 * FortMesa gateway tools are `grc_<family>[_<method...>]`
 * (`grc_documents_upload_url` -> `documents` · `upload_url`). Tools with no
 * method segment (`grc_scopes`, `grc_plans`) take their method from the call's
 * `method` argument when the call carries one, which is the gateway's own
 * convention for those verb-dispatched tools.
 *
 * A name that does not match the convention at all degrades to
 * `family: 'tool'` with no method rather than echoing the name: an unknown
 * name is unvalidated input, and this function's contract is that its output
 * is always renderable verbatim.
 */
export function summarizeToolCall(toolName: unknown, args: unknown): ToolSummary {
  const name = typeof toolName === 'string' ? toolName : '';
  const stripped = name.startsWith('grc_') ? name.slice(4) : name;
  const segments = stripped.split('_').filter((segment) => segment.length > 0);

  const family = segments.length > 0 && isSafeToken(segments[0]) ? segments[0] : 'tool';

  if (segments.length > 1) {
    const method = segments.slice(1).join('_');
    return isSafeToken(method) ? { family, method } : { family };
  }

  // Verb-dispatched tools: read ONLY `method`, and only if it is a short
  // identifier. Nothing else in `args` is read, here or anywhere else.
  const argMethod: unknown =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>).method : undefined;
  return isSafeToken(argMethod) ? { family, method: argMethod } : { family };
}

/**
 * The last six characters of a scope id, for the case where the scope's
 * display name is NOT already on screen (an unlocked proxy knows ids, not
 * names). Short enough to be an identifier rather than a record, long enough
 * to tell two scopes apart in a 30-row timeline.
 */
export function scopeShortId(scopeId: unknown): string | undefined {
  if (typeof scopeId !== 'string' || scopeId.length === 0) return undefined;
  const short = scopeId.slice(-6);
  return isSafeToken(short) ? short : undefined;
}

/**
 * Pick the scope label for a record: the display `name` when the caller has
 * one (it has one exactly when the proxy is scope-locked, which is exactly
 * when that name is already rendered in the Scope selector), else the short id.
 */
export function scopeLabel(scopeId: unknown, displayName: unknown): string | undefined {
  if (isSafeToken(displayName)) return displayName;
  return scopeShortId(scopeId);
}

/** HTTP status codes mentioned by MCP/transport errors, as a number when one is present. */
function statusFrom(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const candidate: unknown =
      (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  const text = messageOf(error);
  const match = /\b(4\d{2}|5\d{2})\b/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

/**
 * Classify a failure into one of the closed {@link ErrorClass} values.
 *
 * The message is inspected here and **discarded here** — callers get the class
 * and nothing else. `blocked` is passed explicitly by Saferoom's own refusals
 * (disabled tool, scope lock, reload quarantine), which never reach the wire
 * and so have no status to read.
 */
export function classifyError(error: unknown): ErrorClass {
  const text = messageOf(error).toLowerCase();
  const status = statusFrom(error);

  if (status === 401 || text.includes('unauthorized') || text.includes('token expired')) return '401 expired';
  if (status === 403 || text.includes('forbidden')) return '403 denied';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('etimedout')) return 'timeout';
  if (
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('enotfound') ||
    text.includes('socket hang up') ||
    text.includes('fetch failed') ||
    text.includes('network')
  ) {
    return 'network';
  }
  if (status !== undefined && status >= 500) return '5xx';
  if (status !== undefined && status >= 400) return '4xx';
  return 'error';
}

/** Glyph for an outcome — `●` running, `✓` ok, `✕` error; `↻` for auth events. */
export function outcomeGlyph(record: Pick<EventRecord, 'kind' | 'outcome'>): string {
  if (record.outcome === 'running') return '●';
  if (record.kind.startsWith('auth.') && record.outcome === 'ok') return '↻';
  return record.outcome === 'ok' ? '✓' : '✕';
}

/** A duration a person can read at a glance: `40ms`, `1.2s`, `12s`. */
export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${String(Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${String(Math.round(seconds))}s`;
}

/**
 * Relative time, the only time format this feature shows.
 *
 * Absolute timestamps were rejected: a timeline of thirty one-line rows is
 * read as "what is happening now", and a wall clock makes the reader do the
 * subtraction. It is also the format that ages honestly across a pane that
 * has been sitting open.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - ts);
  if (elapsed < 5_000) return 'now';
  if (elapsed < 60_000) return `${String(Math.floor(elapsed / 1000))}s ago`;
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))}m ago`;
  return `${String(Math.floor(elapsed / 3_600_000))}h ago`;
}

/**
 * The WWMD one-liner for the **sidebar** — what the reader wants to know,
 * in the order they want it, short enough to fit one narrow line and wrap to
 * at most two.
 *
 *   `✓ documents · upload_url  120ms  now`
 *   `✕ controls · read  401 expired  3m ago`
 *
 * The fullscreen panel renders the same record with the extra columns
 * (scope, relayed) as separate cells rather than lengthening this string.
 */
export function sidebarLine(record: EventRecord, now: number = Date.now()): string {
  const subject = record.method === undefined ? record.family : `${record.family} · ${record.method}`;
  const parts = [
    outcomeGlyph(record),
    subject,
    ...(record.outcome === 'error' && record.errorClass !== undefined ? [record.errorClass] : []),
    ...(record.outcome === 'running' ? [] : [formatDuration(record.durationMs) ?? '']),
    formatRelativeTime(record.ts, now),
  ];
  return parts.filter((part) => part.length > 0).join('  ');
}
