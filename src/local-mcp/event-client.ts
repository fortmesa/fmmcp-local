import { connect, type Socket } from 'node:net';
import { encodeRecord, eventSocketPath } from '../registry/events/transport.js';
import type { EventRecord } from '../registry/events/event-record.js';

/**
 * The proxy process's end of the Event viewer wire.
 *
 * ## Contract: the timeline may never cost a tool call anything
 *
 * This is telemetry for a sidebar pane. It sits on the hot path of every
 * `tools/call`, so every decision here is made in favour of the tool call:
 *
 *  - **Never throws, never rejects.** `emit` is synchronous and fire-and-forget.
 *  - **Never blocks.** If the socket is not connected, the record is dropped,
 *    not queued. There is no backlog to flush, so a slow or absent viewer
 *    cannot apply backpressure to the agent.
 *  - **Never keeps the process alive.** The socket and the reconnect timer are
 *    both `unref()`d, so the proxy exits exactly when it would have anyway.
 *  - **Never retries in a tight loop.** One reconnect attempt at a fixed
 *    interval; a machine with no Saferoom extension running (Claude Code on
 *    its own, say) does nothing but set a timer that never succeeds.
 *
 * Dropping events is therefore normal and expected, not a fault to be
 * engineered away: the pane's contract with the user is "what happened while
 * you were watching", not "a complete audit log". An audit log is what the
 * subscription seam in `registry/events/event-bus.ts` is there to carry later,
 * and it would need a different transport with different guarantees.
 */

/** How long to wait before trying the socket again after a failure. */
const RECONNECT_INTERVAL_MS = 5_000;

export interface EventClient {
  /** Publish one already-redacted record. Best-effort; silent on failure. */
  readonly emit: (record: EventRecord) => void;
  readonly close: () => void;
}

/** An `EventClient` that discards everything — used when eventing is switched off. */
export const NO_EVENT_CLIENT: EventClient = {
  emit: () => {
    /* discard */
  },
  close: () => {
    /* nothing to close */
  },
};

/**
 * Open a best-effort connection to the extension host's event sink.
 *
 * Returns immediately — the first connection attempt is in flight, and any
 * records emitted before it lands are dropped.
 */
export function createEventClient(socketPath: string = eventSocketPath()): EventClient {
  let socket: Socket | undefined;
  let connecting = false;
  let closed = false;
  let retryTimer: NodeJS.Timeout | undefined;

  const scheduleRetry = (): void => {
    if (closed || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      open();
    }, RECONNECT_INTERVAL_MS);
    retryTimer.unref();
  };

  function open(): void {
    if (closed || connecting || socket !== undefined) return;
    connecting = true;
    let candidate: Socket;
    try {
      candidate = connect(socketPath);
    } catch {
      // An invalid path (or a platform that refuses it outright) is not worth
      // reporting on stderr: stderr is the proxy's log channel and the agent's
      // user has no action to take.
      connecting = false;
      scheduleRetry();
      return;
    }
    candidate.unref();
    candidate.setNoDelay(true);
    candidate.on('connect', () => {
      connecting = false;
      socket = candidate;
    });
    const fail = (): void => {
      connecting = false;
      if (socket === candidate) socket = undefined;
      candidate.destroy();
      scheduleRetry();
    };
    candidate.on('error', fail);
    candidate.on('close', fail);
  }

  open();

  return {
    emit: (record: EventRecord): void => {
      const live = socket;
      if (live === undefined || live.destroyed) {
        // No viewer is listening. Make sure a reconnect is pending, then drop.
        if (!connecting) scheduleRetry();
        return;
      }
      try {
        live.write(encodeRecord(record));
      } catch {
        // A write that fails takes the connection with it via the 'error'
        // handler above; the record itself is simply lost.
      }
    },
    close: (): void => {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      socket?.destroy();
      socket = undefined;
    },
  };
}
