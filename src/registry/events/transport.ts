/**
 * The wire between the **local MCP proxy process** and the **extension host**.
 *
 * ## Why a wire exists at all
 *
 * The proxy is not part of the extension host. `launch-mcp.sh` is spawned by
 * whichever agent is using Saferoom — VS Code's `vscode.lm` MCP client, Claude
 * Code, Cursor, Codex — as its own OS process talking JSON-RPC over stdio. The
 * extension only ever hands out the *command to run* (`extension.ts`'s
 * `resolveServerSpec`). So the events the pane exists to show are produced in
 * a process that cannot touch the extension host's memory.
 *
 * ## What crosses it, and what cannot
 *
 * Only an already-summarised {@link EventRecord}: a tool family, a method, an
 * outcome, a duration, a short scope label. The redaction happens **in the
 * producer** (`summarize.ts`) before anything is serialised, so no request or
 * response payload is ever written to this socket even momentarily. That is
 * the reason the redaction is not done on the extension side: a wire carrying
 * payloads "that get filtered later" is a wire that leaks the day someone
 * adds a second consumer.
 *
 * ## Why a socket and not a file
 *
 * The requirement is no data remnants — nothing readable after the window is
 * closed. A log file the extension tails would put exactly this data at rest.
 * A unix domain socket (a named pipe on Windows) holds nothing: bytes exist
 * only in flight, the endpoint is created by the listener and removed when it
 * disposes, and if nobody is listening the producer drops the event on the
 * floor rather than buffering it anywhere.
 *
 * ## Trust
 *
 * The socket is local and mode-0600, but it is still an input. Anything a
 * process on this machine can connect and write is re-validated by
 * {@link sanitizeIncoming} before it can reach a webview: unknown kinds and
 * error classes are rejected, and every free string must pass `SAFE_TOKEN`'s
 * character class and 32-character cap. A hostile local writer can therefore
 * add a *row*, but cannot put prose, markup, or a long string of its choosing
 * into the pane.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ERROR_CLASSES,
  EVENT_KINDS,
  EVENT_OUTCOMES,
  isSafeToken,
  type ErrorClass,
  type EventKind,
  type EventOutcome,
  type EventRecord,
} from './event-record.js';

/**
 * Where the listener binds.
 *
 * Windows has no filesystem sockets, so it gets a named pipe — which is
 * purely in-kernel and therefore leaves nothing behind even in principle.
 * `FMCODE_EVENT_SOCKET` overrides both, for tests and for the rare host whose
 * home directory is not writable. `FMCODE_DIR` is honoured for the same
 * reason `registry/config.ts` honours it.
 */
export function eventSocketPath(): string {
  const override = process.env.FMCODE_EVENT_SOCKET;
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === 'win32') return '\\\\.\\pipe\\fortmesa-saferoom-events';
  const dir = process.env.FMCODE_DIR ?? join(homedir(), '.fmcode');
  return join(dir, 'events.sock');
}

/** One record, one line. NDJSON so a partial write is detectable by the absence of `\n`. */
export function encodeRecord(record: EventRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Validate and re-sanitise a record that arrived over the wire.
 *
 * Returns `undefined` for anything that is not a well-formed record — a
 * malformed line is dropped silently rather than surfaced, because the only
 * thing a caller could do with "someone wrote junk to the socket" is render
 * it, which is the outcome this function exists to prevent.
 *
 * Note that this REBUILDS the record field by field rather than spreading the
 * parsed object: an attacker-supplied extra key cannot ride along into a
 * consumer that happens to read it.
 */
export function sanitizeIncoming(value: unknown): EventRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Record<string, unknown>;

  if (!isSafeToken(input.id)) return undefined;
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) return undefined;
  if (!isOneOf<EventKind>(input.kind, EVENT_KINDS)) return undefined;
  if (!isOneOf<EventOutcome>(input.outcome, EVENT_OUTCOMES)) return undefined;
  if (!isSafeToken(input.family)) return undefined;

  const method = isSafeToken(input.method) ? input.method : undefined;
  const scope = isSafeToken(input.scope) ? input.scope : undefined;
  const errorClass = isOneOf<ErrorClass>(input.errorClass, ERROR_CLASSES) ? input.errorClass : undefined;
  const durationMs =
    typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? input.durationMs
      : undefined;
  const relayed = typeof input.relayed === 'boolean' ? input.relayed : undefined;

  return {
    id: input.id,
    ts: input.ts,
    kind: input.kind,
    family: input.family,
    outcome: input.outcome,
    ...(method === undefined ? {} : { method }),
    ...(scope === undefined ? {} : { scope }),
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(relayed === undefined ? {} : { relayed }),
  };
}

/**
 * Split a growing NDJSON buffer into whole lines, returning the parsed,
 * sanitised records and whatever trailing partial line is left over.
 *
 * The leftover is capped: a peer that never sends a newline must not be able
 * to grow the extension host's memory without bound. Past the cap the buffer
 * is discarded (the connection is producing garbage, and the next newline
 * resynchronises).
 */
export const MAX_PENDING_BYTES = 64 * 1024;

export function decodeLines(buffer: string): { readonly records: EventRecord[]; readonly rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const records: EventRecord[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = sanitizeIncoming(parsed);
    if (record !== undefined) records.push(record);
  }
  return { records, rest: rest.length > MAX_PENDING_BYTES ? '' : rest };
}
