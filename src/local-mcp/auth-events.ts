import { newEventId, type ErrorClass } from '../registry/events/event-record.js';
import { classifyError } from '../registry/events/summarize.js';
import type { EventClient } from './event-client.js';
import type { RefreshOutcome } from '../registry/token-refresh.js';

/**
 * The Event viewer's auth half, as produced by the **proxy process**.
 *
 * The extension host publishes `auth.signin` / `auth.signout` directly into
 * the bus (it owns those flows — see `extension.ts`). The other two auth
 * events cannot be produced there, because they do not happen there: a token
 * is refreshed, and a session is found to have expired, inside
 * `resolveCredentials` on the proxy's per-request credential path. Without
 * this module those two `EventKind`s were declared, documented and never
 * emitted — the pane would show the sign-in and then go silent for exactly
 * the two events a user most needs to see ("it renewed itself" and "you need
 * to sign in again").
 *
 * ## What is allowed out
 *
 * The environment name is NOT emitted. It is not a secret, but it is also not
 * the subject of the row — the pane says *what happened to your session*, and
 * which environment it happened in is already on screen in the Signed-in user
 * card. Leaving it out keeps the auth rows to the same two-token shape as
 * every other row.
 *
 * `RefreshOutcome.error` is a free-text failure string that can quote an
 * OAuth endpoint's response, so it is passed through `classifyError` and
 * reduced to a closed-set {@link ErrorClass}. The text itself never leaves
 * this function.
 */

/** Publish the `auth.refresh` row for one refresh attempt, if it did anything. */
export function emitRefreshEvent(events: EventClient, outcome: RefreshOutcome): void {
  // 'not-needed' / 'no-refresh-token' / 'no-client-id' are the quiet cases:
  // nothing was attempted, so a row would be noise on every single request.
  if (outcome.reason === 'not-needed' || outcome.reason === 'no-refresh-token' || outcome.reason === 'no-client-id') {
    return;
  }
  const failed = outcome.reason === 'failed';
  events.emit({
    id: newEventId(),
    ts: Date.now(),
    kind: 'auth.refresh',
    family: 'auth',
    method: outcome.reason === 'raced' ? 'refresh_raced' : 'refresh',
    outcome: failed ? 'error' : 'ok',
    ...(failed ? { errorClass: classifyError(outcome.error) } : {}),
  });
}

/**
 * Publish the `auth.expired` row.
 *
 * Called when the credential chain refused to hand out a token because what
 * it had was expired — the one failure in this feature the user can actually
 * act on, which is why it gets its own kind rather than folding into a
 * `401 expired` on whichever tool call happened to be next.
 */
export function emitExpiredEvent(events: EventClient, errorClass: ErrorClass = '401 expired'): void {
  events.emit({
    id: newEventId(),
    ts: Date.now(),
    kind: 'auth.expired',
    family: 'auth',
    method: 'expired',
    outcome: 'error',
    errorClass,
  });
}
