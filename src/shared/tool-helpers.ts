/**
 * Shared helpers for MCP tool handlers.
 */

import { ApiError } from './api-client.js';

/** Machine-readable backend error `code` from a failed apiFetch() call, if present. */
export function apiErrorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** HTTP status of the failed upstream call, if the error came from apiFetch(). */
export function apiErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

/** Machine-readable `details` payload from the v2 error contract, if present. */
export function apiErrorDetails(error: unknown): unknown {
  return error instanceof ApiError ? error.details : undefined;
}

/**
 * Backend-error-code → remediation hint, appended to tool error text.
 *
 * Ported from fmmcp-gw's `taskRemediationHint` (src/tools/tasks.ts) — NOT
 * cross-repo imported, per this packet's brief. fmmcp-local's local tools
 * (documents — the only ones that call the Continurisk API directly rather
 * than relaying through the gateway, see registry.ts's module doc) reach the
 * BE directly and got ZERO hint text before this change: api-client.ts threw
 * a bare `Error` with no `code` at all. Every code the gateway table knows is
 * ported here (not filtered to "documents-only" codes) so a local tool that
 * starts reaching a wider slice of the BE doesn't silently regress to zero
 * guidance — and so the two hint tables stay comparable across repos.
 *
 * Ends with the SAME unknown-code floor as the gateway: a defined-but-unmatched
 * code names itself rather than falling through to an empty string that reads
 * as "benign/retryable" when it may not be.
 */
export function remediationHint(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === 'agent_excluded') {
    return (
      ' This task type cannot be created/completed by agents (human-authority boundary). ' +
      'Check mcpWritable/mcpCompletable via grc_tasks_read list_task_types. A human must ' +
      'perform this action in the FortMesa app.'
    );
  }
  if (code === 'role_required') {
    return (
      " Completing this task type requires a scope role your token's owner does not hold " +
      '(e.g. assessment → assessor). Do not retry; tell the user.'
    );
  }
  if (code === 'invalid_transition') {
    return (
      ' The task/record is in a state that does not allow this transition (e.g. already done, ' +
      'or already promoted). Re-read it first (grc_tasks_read).'
    );
  }
  if (code === 'interview_not_submitted') {
    return (
      ' external_interview tasks can only be completed after the interview is submitted AND ' +
      'a member has reviewed it. Check interview status via grc_tasks_read get_interview.'
    );
  }
  if (code === 'invalid_rrule') {
    const details = apiErrorDetails(error) as { field?: string } | undefined;
    return (
      ` Your ${details?.field ?? 'schedule.rrule'}'s INTERVAL is invalid — it must be a positive ` +
      'integer (e.g. INTERVAL=1). Fix the value and retry.'
    );
  }
  if (code === 'duplicate_edge') {
    return ' This link already exists. Read the existing edges first (grc_tasks_read list_links).';
  }
  if (code === 'feature_not_released') {
    return (
      ' This feature is not enabled for this scope. This is a FortMesa-controlled release ' +
      'switch, not an error in your request — do not retry. Other scopes may have it enabled ' +
      '(grc_scopes list); otherwise tell the user to contact FortMesa about availability.'
    );
  }
  if (code === 'validation_failed') {
    const details = apiErrorDetails(error) as { errors?: unknown } | undefined;
    return details?.errors !== undefined ? ` Validation errors: ${JSON.stringify(details.errors)}` : '';
  }
  if (apiErrorStatus(error) === 404) {
    return ' Record not found in this scope. IDs are scope-local — verify the id and the scopeId together.';
  }
  // Unknown-code floor: `code` is a real, defined backend error code (apiErrorCode()
  // returned something), but none of the branches above recognized it. Without this, a
  // newly-added BE code silently degrades to zero guidance until someone remembers to add
  // a branch here — indistinguishable from a benign, retryable failure. Name the code
  // verbatim so the caller (agent or human) can act on it even though this hint table
  // doesn't yet know what it means. Text matches the gateway's floor verbatim (see
  // fmmcp-gw src/tools/tasks.ts taskRemediationHint).
  if (code !== undefined) {
    return ` This is an unrecognized backend error code ("${code}") — do not assume it's retryable; check the FortMesa app for the current state.`;
  }
  return '';
}

/** Structured error response for MCP tool calls. */
export function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  };
}

/** Structured success response wrapping JSON data. */
export function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Extract human-readable error message from unknown throw. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Validate a conditionally-required parameter and throw a clear error if missing. */
export function requireParam<T>(name: string, value: T): asserts value is NonNullable<T> {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Parameter "${name}" is required for this method.`);
  }
}

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
  /** Initial delay before first check in ms. Default: 5000. */
  initialDelayMs?: number;
  /** Max delay between checks in ms. Default: 80000. */
  maxDelayMs?: number;
  /** Total timeout in ms. Default: 300000 (5 min). */
  timeoutMs?: number;
  /** Predicate: return true when the resource is ready. Default: checks for non-null data. */
  isReady?: (result: unknown) => boolean;
}

/**
 * Poll a fetch function with exponential backoff until a condition is met.
 * Returns the final result. Throws on timeout.
 */
export async function pollUntilReady(fetchFn: () => Promise<unknown>, options: PollOptions = {}): Promise<unknown> {
  const initialDelay = options.initialDelayMs ?? 5000;
  const maxDelay = options.maxDelayMs ?? 80000;
  const timeout = options.timeoutMs ?? 300000;
  const isReady = options.isReady ?? ((result: unknown) => result !== null && result !== undefined);

  const startTime = Date.now();
  let delay = initialDelay;

  while (Date.now() - startTime < timeout) {
    await sleep(delay);

    const result = await fetchFn();
    if (isReady(result)) {
      return result;
    }

    delay = Math.min(delay * 2, maxDelay);
  }

  throw new Error(`Polling timed out after ${String(timeout)}ms.`);
}
