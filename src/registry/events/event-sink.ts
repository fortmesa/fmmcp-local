import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { decodeLines, eventSocketPath } from './transport.js';
import type { EventBus } from './event-bus.js';
import type { EventRecord } from './event-record.js';
import { errorMessage } from '../../shared/errors.js';

/**
 * The extension host's end of the Event viewer wire — the listener the local
 * MCP proxy processes connect to.
 *
 * See `registry/events/transport.ts` for why a wire is needed at all (the
 * proxy is a separate process) and why it is a socket rather than a file
 * (nothing at rest). This module is the part that touches the OS.
 *
 * ## Stale endpoints
 *
 * A unix socket file outlives a crashed listener, and `listen()` on an
 * existing path fails with `EADDRINUSE`. That is ambiguous — it means either
 * "another Saferoom window owns the timeline" or "the last one died badly" —
 * so we *probe* before assuming: the fallback path unlinks and retries once,
 * and a second failure is accepted as "another window has it" and logged.
 * The pane in this window then simply shows only the events this window's own
 * extension host produces (sign-in, sign-out), which is honest: it never
 * claims a complete timeline it is not receiving.
 *
 * ## Trust boundary
 *
 * Any local process can connect. Records are sanitised by `decodeLines` before
 * they reach the bus, so an untrusted writer can add a row but cannot put
 * arbitrary text, markup or a long string into it. The socket is chmod-0600
 * on platforms that have file modes, so in practice the writer has to be this
 * user anyway.
 *
 * Lives in `src/registry/**` rather than `src/extension/**` — and takes its
 * logger as a two-method interface rather than importing `extension/logger.ts`
 * — for the reason the whole of `registry/` is `vscode`-free: the wire is the
 * piece most worth an end-to-end test (a real socket, a real client, a real
 * record read back out of the bus), and a module that imports `vscode` cannot
 * be loaded by a plain Node test. See `test/registry/event-wire.test.mjs`.
 */

/** The subset of `extension/logger.ts`'s `Logger` this module needs. */
export interface SinkLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** A `vscode.Disposable`-shaped handle over the listening socket. */
export interface EventSink {
  dispose(): void;
  /** The path actually bound, or `undefined` when binding failed. */
  readonly boundPath: string | undefined;
}

/** Apply one arriving record to the bus: settle an open row, or open a new one. */
export function acceptRecord(bus: EventBus, record: EventRecord): void {
  const settled = bus.settle(record.id, {
    outcome: record.outcome,
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
    ...(record.relayed === undefined ? {} : { relayed: record.relayed }),
  });
  if (settled === undefined) bus.publish(record);
}

/**
 * Start listening for proxy events and feed them into `bus`.
 *
 * Never throws: a host where the socket cannot be bound degrades to a pane
 * that shows only extension-host-produced events, which is strictly better
 * than failing activation over a timeline widget.
 */
export function startEventSink(bus: EventBus, log: SinkLogger, socketPath: string = eventSocketPath()): EventSink {
  const sockets = new Set<Socket>();
  let bound: string | undefined;
  let disposed = false;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk: string) => {
      const { records, rest } = decodeLines(pending + chunk);
      pending = rest;
      for (const record of records) acceptRecord(bus, record);
    });
    const drop = (): void => {
      sockets.delete(socket);
      socket.destroy();
    };
    socket.on('error', drop);
    socket.on('close', drop);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    log.warn(`Event viewer: socket error, live proxy events unavailable in this window (${errorMessage(error)})`);
  });

  const bind = (isRetry: boolean): void => {
    server.listen(socketPath, () => {
      bound = socketPath;
      if (process.platform !== 'win32') {
        // Best effort: the timeline is not secret, but it names scopes, and
        // there is no reason for another account on this machine to read it.
        try {
          chmodSync(socketPath, 0o600);
        } catch (error) {
          log.warn(`Event viewer: could not restrict socket permissions: ${errorMessage(error)}`);
        }
      }
      log.info('Event viewer: listening for local MCP events');
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && !isRetry && process.platform !== 'win32') {
        // Either a live sibling window owns it, or a crashed one left it
        // behind. Clear it and try exactly once more; if a live listener is
        // genuinely there, the retry fails and we accept that.
        try {
          unlinkSync(socketPath);
        } catch {
          // Nothing to remove, or not ours to remove — the retry will say so.
        }
        if (!disposed) bind(true);
        return;
      }
      log.info(
        `Event viewer: another window is serving the local MCP timeline; this pane shows this window's own events only`,
      );
    });
  };

  bind(false);

  return {
    get boundPath(): string | undefined {
      return bound;
    },
    dispose: (): void => {
      disposed = true;
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      server.close();
      if (bound !== undefined && process.platform !== 'win32') {
        try {
          unlinkSync(bound);
        } catch {
          // Already gone — the only thing that matters is that it is not left behind.
        }
      }
      bound = undefined;
    },
  };
}
