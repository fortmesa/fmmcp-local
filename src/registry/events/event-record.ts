import { randomBytes } from 'node:crypto';

/**
 * The **Event viewer**'s record type — the one shape that travels from every
 * producer (the local MCP proxy, the extension host's own auth flows) to
 * every consumer (the sidebar pane, the fullscreen panel, and whatever log
 * sink subscribes later).
 *
 * Two properties are load-bearing and must survive any future edit:
 *
 *  1. **It is already redacted.** An `EventRecord` carries no request or
 *     response payload, no file path, no document title, no email, no token,
 *     and no free-text error message. It carries a tool *family* and *method*
 *     (`documents` · `upload_url`), an outcome, a duration, and a relative
 *     time. Producers build one via `summarize.ts`, which reads a strict
 *     allowlist of fields off the call — not by stripping known-bad keys off
 *     a payload, which is the shape of redaction that leaks.
 *  2. **It is serialisable.** Records cross a process boundary as NDJSON (the
 *     proxy is a separate process — see `events/transport.ts`), so every
 *     field is a primitive. No `Error`, no `Date`, no class instance.
 *
 * `kind` is deliberately an open-ended string union rather than a boolean
 * "is a tool call": the pane groups by it today, and the future log stream
 * the PO asked us to build *towards* (but not build) will route by it.
 */

/** What happened. Extend by adding a member — consumers must tolerate unknown kinds. */
export type EventKind =
  /** An MCP `tools/call` handled by the local server (local dispatch or gateway relay). */
  | 'tool.call'
  /** Interactive sign-in completed. */
  | 'auth.signin'
  /** Stored credential cleared for an environment. */
  | 'auth.signout'
  /** A stored refresh token was spent for a new access token. */
  | 'auth.refresh'
  /** The stored credential was found to have expired. */
  | 'auth.expired'
  /** The proxy connected to the cloud gateway. */
  | 'gateway.connect'
  /** The gateway connection was closed. */
  | 'gateway.disconnect'
  /** A hot reload re-pointed the proxy at a gateway. */
  | 'gateway.reconnect';

export const EVENT_KINDS: readonly EventKind[] = [
  'tool.call',
  'auth.signin',
  'auth.signout',
  'auth.refresh',
  'auth.expired',
  'gateway.connect',
  'gateway.disconnect',
  'gateway.reconnect',
];

/** Where a settled event landed. `running` is the in-flight state the pane shows as `●`. */
export type EventOutcome = 'running' | 'ok' | 'error';

export const EVENT_OUTCOMES: readonly EventOutcome[] = ['running', 'ok', 'error'];

/**
 * The error **class** — never the error text.
 *
 * A gateway error message can quote the request that produced it (ids, paths,
 * a rejected argument), so the message itself is exactly the thing this
 * feature must not display. The classes below are the whole vocabulary: an
 * unrecognised failure becomes `'error'`, which says "it failed" and nothing
 * a payload could have contributed.
 */
export type ErrorClass =
  /** 401 with an expired/invalid credential — the one a user can act on. */
  | '401 expired'
  /** 403 — authenticated but refused. */
  | '403 denied'
  /** Any other 4xx. */
  | '4xx'
  /** Any 5xx. */
  | '5xx'
  /** The call timed out. */
  | 'timeout'
  /** The transport failed (connection refused/reset, DNS, socket closed). */
  | 'network'
  /** Saferoom itself refused before the call left the box (disabled tool, scope lock, quarantine). */
  | 'blocked'
  /** Anything else. */
  | 'error';

export const ERROR_CLASSES: readonly ErrorClass[] = [
  '401 expired',
  '403 denied',
  '4xx',
  '5xx',
  'timeout',
  'network',
  'blocked',
  'error',
];

/** One timeline entry. Already redacted by construction — see the module doc. */
export interface EventRecord {
  /** Stable within one IDE load; used to settle a `running` record in place. */
  readonly id: string;
  /** Epoch milliseconds. Rendered as a relative time; never shown as a wall clock. */
  readonly ts: number;
  readonly kind: EventKind;
  /**
   * Tool family or subsystem — `documents`, `scopes`, `controls`, `auth`,
   * `gateway`. Constrained to {@link SAFE_TOKEN} so it can never carry prose.
   */
  readonly family: string;
  /** Method within the family (`upload_url`, `list`). Same constraint as `family`. */
  readonly method?: string;
  readonly outcome: EventOutcome;
  /** Wall duration in ms, present once the event settles. */
  readonly durationMs?: number;
  /** Present only when `outcome === 'error'`. */
  readonly errorClass?: ErrorClass;
  /**
   * The scope this happened in: its **display name** when that name is already
   * on screen in the sidebar (i.e. the proxy is scope-locked to it), otherwise
   * a six-character short id. Never a raw full scope id.
   */
  readonly scope?: string;
  /** True when the call was relayed to the cloud gateway, false when served locally. */
  readonly relayed?: boolean;
}

/**
 * The only shape a `family`/`method`/`scope` token may take.
 *
 * The length cap is the real defence, not the character class: it is what
 * makes it structurally impossible for a bearer token, a JWT, a file path or
 * an email to occupy one of these fields even if a producer were to pass one
 * in. See `test/registry/event-redaction.test.mjs`.
 */
export const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

/** True when `value` is a token safe to render verbatim in the pane. */
export function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TOKEN.test(value);
}

/**
 * A fresh record id.
 *
 * Random rather than a counter because two producers (the proxy process and
 * the extension host) publish into one buffer and must never collide on an
 * id — `EventBus.settle` addresses records by it. Twelve hex characters, so
 * it satisfies {@link SAFE_TOKEN} and survives the wire sanitiser.
 */
export function newEventId(): string {
  return randomBytes(6).toString('hex');
}
