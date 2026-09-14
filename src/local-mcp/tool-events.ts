import { newEventId, type ErrorClass, type EventOutcome } from '../registry/events/event-record.js';
import { scopeLabel, summarizeToolCall } from '../registry/events/summarize.js';
import type { EventClient } from './event-client.js';

/**
 * The Event viewer's hook for one `tools/call`.
 *
 * ## Why it is a tracker object rather than two `emit` calls in the handler
 *
 * The invariant the pane depends on is **exactly one timeline row per handled
 * call**, opened when the call arrives and settled once. `proxy.ts`'s
 * `tools/call` handler has six return paths today (quarantine, disabled tool,
 * scope-lock refusal, local dispatch, relay failure, relay success) and will
 * grow more. "Remember to settle the event on the new path too" is precisely
 * the kind of rule that is obeyed five times and forgotten on the sixth, and
 * the symptom — a row stuck on `●` forever — looks like a hung tool call
 * rather than like a missing line of telemetry.
 *
 * So the rule is enforced here instead of remembered there:
 *  - {@link ToolEventTracker.settle} is **idempotent**; a second call is
 *    ignored, so a path that settles twice cannot double-count.
 *  - {@link ToolEventTracker.finalize} settles as a generic failure if nothing
 *    else did. The handler calls it from a `finally`, so a future `return`
 *    that forgets to settle still closes its row, and a `throw` does too.
 *
 * ## Redaction
 *
 * The arguments object reaches `summarizeToolCall` and goes no further: it is
 * never stored on the tracker, never serialised, never logged. What the
 * tracker retains is the family, the (length-capped) method and a short scope
 * label — see `registry/events/summarize.ts` for why the extraction is an
 * allowlist rather than a strip.
 */
export interface ToolEventTracker {
  /** Close the row. The first call wins; later calls are ignored. */
  readonly settle: (
    outcome: EventOutcome,
    detail?: { readonly errorClass?: ErrorClass; readonly relayed?: boolean },
  ) => void;
  /** Settle as a generic failure if nothing has settled yet. Safe to call always. */
  readonly finalize: () => void;
  /** True once the row is closed — exposed for tests, not for control flow. */
  readonly isSettled: () => boolean;
}

/** How the proxy looks up a scope's display name (`ScopeLock.nameFor`), read live. */
export type ScopeNameLookup = (scopeId: string) => string | undefined;

/**
 * Open a timeline row for `name`/`args` and return its tracker.
 *
 * `now` is injectable so the duration assertion in
 * `test/local-mcp/tool-events.test.mjs` is exact rather than a tolerance
 * window around a real clock.
 */
export function beginToolEvent(
  events: EventClient,
  name: unknown,
  args: Record<string, unknown>,
  nameFor: ScopeNameLookup,
  now: () => number = Date.now,
): ToolEventTracker {
  const id = newEventId();
  const startedAt = now();
  const { family, method } = summarizeToolCall(name, args);
  const rawScopeId = typeof args.scopeId === 'string' ? args.scopeId : undefined;
  const scope = scopeLabel(rawScopeId, rawScopeId === undefined ? undefined : nameFor(rawScopeId));

  const common = {
    id,
    ts: startedAt,
    kind: 'tool.call' as const,
    family,
    ...(method === undefined ? {} : { method }),
    ...(scope === undefined ? {} : { scope }),
  };

  events.emit({ ...common, outcome: 'running' });

  let settled = false;

  const settle = (
    outcome: EventOutcome,
    detail?: { readonly errorClass?: ErrorClass; readonly relayed?: boolean },
  ): void => {
    if (settled) return;
    settled = true;
    events.emit({
      ...common,
      outcome,
      durationMs: now() - startedAt,
      ...(detail?.errorClass === undefined ? {} : { errorClass: detail.errorClass }),
      ...(detail?.relayed === undefined ? {} : { relayed: detail.relayed }),
    });
  };

  return {
    settle,
    finalize: () => {
      settle('error', { errorClass: 'error' });
    },
    isSettled: () => settled,
  };
}
