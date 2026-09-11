import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * Local-loopback OAuth callback listener + paste parsing — the two transport
 * paths of PLAN-vsix-signin.md §3.2 ("in your browser, automatically" and
 * "paste the code from the browser"). Deliberately free of `vscode` imports
 * (GEMINI.md / VSIX-PLAN.md §3.1) — shared by the CLI's `login` subcommand,
 * the proxy's first-run sign-in (`registry/login-flow.ts`) and the Saferoom
 * VSIX's sign-in session (`extension/sign-in-session.ts`).
 *
 * `pkce.ts` builds the actual `/authorize` URL; this module never does —
 * building it requires the PKCE `code_challenge`, which only the caller holds.
 *
 * Three round-2 changes (BRIEF-SIGNIN-1 steps 2 and 6), each load-bearing:
 *
 * 1. The `redirect_uri` is no longer derived here. Under a remote extension
 *    host the browser runs on the USER's machine, so the URL Auth0 must
 *    redirect to is the FORWARDED one (`vscode.env.asExternalUri`), which only
 *    the caller can resolve — and it can only resolve it once the port is
 *    bound. Hence `resolveRedirectUri(boundPort)`: the listener binds, the
 *    caller maps the bound port to its externally visible URL, and that value
 *    is what goes to `/authorize` and back into the token exchange.
 * 2. A callback carrying `error` resolves as `cancelled`/`error` instead of
 *    rejecting on a missing `code`. "The user pressed Cancel in Auth0" is an
 *    outcome the sign-in page renders, not an exception.
 * 3. The HTTP response is DEFERRED. The browser is left hanging on
 *    `/callback` until the caller has exchanged the code and knows the real
 *    outcome, then `respond(location)` 302s it to the "You're all set" page.
 *    Responding first (the old fixed HTML page) meant the browser could only
 *    ever be told "something happened", never what. The held response is
 *    hard-timed-out after {@link HELD_RESPONSE_TIMEOUT_MS} so a caller that
 *    dies mid-exchange cannot leave a browser tab spinning forever.
 */

/** Loopback ports to try, in order. Auth0 accepts ANY loopback port for our CIMD clients (probed 2026-09-07, PLAN §2.1 — RFC 8252 §7.3), so these are a convention, not a whitelist. */
export const LOOPBACK_PORTS = [43117, 43118, 43119] as const;

/** The direct (un-forwarded) `redirect_uri` for a loopback port — `http://127.0.0.1:<port>/callback`. Still the right answer for a LOCAL extension host and for the CLI; a remote host forwards it instead (see the module doc). */
export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${String(port)}/callback`;
}

/** How long the deferred `/callback` response is held open waiting for `respond()` before the flow 302s the browser to the caller's error page itself. */
export const HELD_RESPONSE_TIMEOUT_MS = 10000;

/** All candidate ports were occupied (or otherwise failed to bind) — the loopback path is unusable; callers should fall back to the paste method. */
export class LoopbackBindError extends Error {}

/** No callback arrived within `timeoutMs` — callers should fall back to the paste method. */
export class LoopbackTimeoutError extends Error {}

/** The caller aborted the flow (the user pressed Cancel on the sign-in page) before any callback arrived. */
export class LoopbackAbortedError extends Error {}

/** The callback's `state` didn't match what this flow expected — a possible tampering/replay/stale-link condition. Callers must surface this distinctly rather than silently retrying. */
export class LoopbackStateMismatchError extends Error {}

/**
 * The paste path's equivalent of {@link LoopbackStateMismatchError}.
 *
 * Both paths now carry `state` unconditionally (a bare code is refused — see
 * {@link parsePastedCode}), so this is a hard stop on every path rather than a
 * check that a bare-code paste could skip.
 */
export class PastedStateMismatchError extends Error {}

/** What the browser callback said happened. `cancelled` is the user declining in Auth0; `error` is anything else the authorization server reported. */
export type LoopbackOutcomeKind = 'success' | 'cancelled' | 'error';

export interface LoopbackFlowResult {
  readonly outcome: LoopbackOutcomeKind;
  /** The authorization code — present if and only if `outcome === 'success'`. */
  readonly code: string | undefined;
  /** The `redirect_uri` actually used, which the token exchange must repeat verbatim. */
  readonly usedRedirectUri: string;
  /** The authorization server's `error` / `error_description`, when it sent any. Never contains a code or token. */
  readonly errorDescription: string | undefined;
  /**
   * Send the browser on its way with a 302 to `location`, and close the
   * listener. Safe to call once; later calls are no-ops. If it is never
   * called, the flow does it itself after {@link HELD_RESPONSE_TIMEOUT_MS}
   * using the caller's `fallbackRedirect`.
   */
  readonly respond: (location: string) => void;
}

export interface LoopbackFlowOptions {
  /** The authorization server base (used for logging only here; `pkce.ts` builds the URLs). */
  readonly apiBase: string;
  readonly clientId: string;
  readonly log: (message: string) => void;
  /** The `state` this sign-in generated. A callback carrying anything else is a hard stop. */
  readonly expectedState: string;
  /**
   * Map the bound loopback port to the `redirect_uri` the BROWSER will be
   * redirected to — `loopbackRedirectUri(port)` for a local host, the
   * `asExternalUri`-forwarded equivalent for a remote one. Whatever it
   * returns is sent to `/authorize` and repeated on the token request.
   */
  readonly resolveRedirectUri: (boundPort: number) => string | Promise<string>;
  /** Called once the redirect URI is known — the caller's cue to build the authorize URL and open it. */
  readonly onRedirectUriReady: (redirectUri: string) => void;
  /** Where to 302 the held browser response if the caller never calls `respond()`. Plain text only if omitted. */
  readonly fallbackRedirect?: string;
  /**
   * Abort the wait. Required for a cancellable UI: without it a user pressing
   * Cancel leaves the listener holding a port for the rest of `timeoutMs`, so
   * their next attempt binds a DIFFERENT port — and on a remote host that
   * means a second forwarded URI for no reason.
   */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Try binding `server` to `127.0.0.1:port`. Resolves `true` on success, `false` on `EADDRINUSE` (caller tries the next port), rejects on any other bind error. */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.removeListener('listening', onListening);
      if (isNodeErrnoException(error) && error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 302 the browser to `location`, with a plain-text body for anything that is
 * not following redirects (curl, a probe, a scripted check) so the response is
 * still self-describing. Never carries a code, token, or identity.
 */
function redirectBrowser(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    Location: location,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`Sign-in finished. Continue at ${location}\n`);
}

/** Terminal plain-text response for a callback we refuse outright (state mismatch) — there is nothing safe to redirect to and no outcome worth reporting to the app. */
function refuseCallback(res: ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('This sign-in could not be verified. Start the sign-in again from your editor.\n');
}

/** Auth0 reports a user pressing "Deny"/back as `access_denied`; everything else is a genuine failure. */
function classifyCallbackError(error: string): 'cancelled' | 'error' {
  return error === 'access_denied' || error === 'user_cancelled' ? 'cancelled' : 'error';
}

/**
 * Run the loopback OAuth callback flow: bind an HTTP server on the first free
 * port in {@link LOOPBACK_PORTS}, ask the caller to turn that port into the
 * externally visible `redirect_uri`, hand it back via `onRedirectUriReady`
 * (the caller's cue to open the authorize URL), then wait for the redirect to
 * land on `GET /callback`.
 *
 * Resolves — it does NOT throw — for every outcome the authorization server
 * can legitimately report: `success` with a code, `cancelled`, or `error`. The
 * browser response is held open; call `result.respond(location)` once the
 * outcome is final. Rejects only for conditions that are not outcomes:
 *   - `LoopbackBindError` — no port could be bound,
 *   - `LoopbackTimeoutError` — nothing arrived within `timeoutMs`,
 *   - `LoopbackStateMismatchError` — a callback with the wrong `state`
 *     (a hard stop: never silently retried on another path).
 *
 * The HTTP server is always closed: immediately on a rejection, and on
 * `respond()` (or the held-response timeout) for a resolution.
 */
export async function runLocalLoopbackFlow(options: LoopbackFlowOptions): Promise<LoopbackFlowResult> {
  const { apiBase, clientId, log, expectedState, resolveRedirectUri, onRedirectUriReady } = options;
  const timeoutMs = options.timeoutMs ?? 120000;
  const server = createServer();
  let boundPort: number | undefined;

  try {
    for (const port of LOOPBACK_PORTS) {
      // Ports must be tried strictly in order, one bind attempt at a time —
      // trying them concurrently would defeat "the FIRST free port".
      const bound = await tryListen(server, port);
      if (bound) {
        boundPort = port;
        break;
      }
    }
  } catch (error) {
    server.close();
    throw new LoopbackBindError(`could not start the local OAuth callback listener (${errorMessage(error)}).`);
  }

  if (boundPort === undefined) {
    server.close();
    throw new LoopbackBindError(
      `could not bind the local OAuth callback listener on any of ports [${LOOPBACK_PORTS.join(', ')}] — all appear to be in use.`,
    );
  }

  let redirectUri: string;
  try {
    redirectUri = await resolveRedirectUri(boundPort);
  } catch (error) {
    server.close();
    throw new LoopbackBindError(
      `could not resolve an externally reachable redirect URI for 127.0.0.1:${String(boundPort)} (${errorMessage(error)}).`,
    );
  }

  log(`OAuth loopback listener bound on 127.0.0.1:${String(boundPort)} (client "${clientId}", ${apiBase}).`);
  onRedirectUriReady(redirectUri);

  let closed = false;
  const closeServer = (): void => {
    if (closed) return;
    closed = true;
    server.close();
  };

  try {
    return await new Promise<LoopbackFlowResult>((resolve, reject) => {
      let settled = false;

      // A hoisted declaration so `timer` below can be a genuine `const` —
      // `settle` is only ever called from a callback, never during this
      // synchronous setup.
      function settle(fn: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }

      const timer = setTimeout(() => {
        settle(() => {
          closeServer();
          reject(new LoopbackTimeoutError(`timed out after ${String(timeoutMs)}ms waiting for the OAuth callback.`));
        });
      }, timeoutMs);

      const onAbort = (): void => {
        settle(() => {
          closeServer();
          reject(new LoopbackAbortedError('the sign-in was cancelled before the browser redirect arrived.'));
        });
      };
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${String(boundPort)}`);
        if (requestUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found\n');
          return;
        }

        const receivedState = requestUrl.searchParams.get('state');
        const code = requestUrl.searchParams.get('code');
        const errorParam = requestUrl.searchParams.get('error');
        const errorDescription = requestUrl.searchParams.get('error_description');

        settle(() => {
          if (receivedState !== expectedState) {
            // Nothing about this request is trustworthy, so it gets no
            // redirect and no outcome — just a refusal, and a hard stop.
            refuseCallback(res);
            closeServer();
            reject(
              new LoopbackStateMismatchError(
                `OAuth callback "state" mismatch — expected "${expectedState}", received ` +
                  `${receivedState === null ? '(none)' : `"${receivedState}"`}. Aborting (possible tampering or a stale link).`,
              ),
            );
            return;
          }

          // The response is held from here on. Whatever settles it — the
          // caller's respond(), or this timer — also closes the listener.
          let responded = false;
          const heldTimer = setTimeout(() => {
            if (responded) return;
            responded = true;
            if (options.fallbackRedirect !== undefined) {
              redirectBrowser(res, options.fallbackRedirect);
            } else {
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end('Sign-in finished. You can close this window.\n');
            }
            closeServer();
          }, HELD_RESPONSE_TIMEOUT_MS);
          // A held response must never keep a CLI process alive on its own.
          heldTimer.unref();

          const respond = (location: string): void => {
            if (responded) return;
            responded = true;
            clearTimeout(heldTimer);
            redirectBrowser(res, location);
            closeServer();
          };

          if (errorParam !== null && errorParam !== '') {
            resolve({
              outcome: classifyCallbackError(errorParam),
              code: undefined,
              usedRedirectUri: redirectUri,
              errorDescription: errorDescription !== null && errorDescription !== '' ? errorDescription : errorParam,
              respond,
            });
            return;
          }

          if (code === null || code === '') {
            resolve({
              outcome: 'error',
              code: undefined,
              usedRedirectUri: redirectUri,
              errorDescription: 'the sign-in callback arrived without an authorization code.',
              respond,
            });
            return;
          }

          resolve({ outcome: 'success', code, usedRedirectUri: redirectUri, errorDescription: undefined, respond });
        });
      });
    });
  } catch (error) {
    closeServer();
    throw error;
  }
}

/** The result of {@link parsePastedCode} — always both halves, so `state` is verifiable on every path. */
export interface PastedAuthorization {
  readonly code: string;
  readonly state: string;
}

/** The refusal message for a paste that carries no `state`. Single-sourced so the page, the CLI and the tests all say the same thing. */
export const PASTE_NEEDS_BOTH_PARTS = 'Paste the whole code — it has two parts joined by #.';

/**
 * Verify a pasted authorization against the `state` this sign-in generated,
 * throwing {@link PastedStateMismatchError} on a mismatch. Mandatory on every
 * paste: {@link parsePastedCode} refuses input that carries no state, so there
 * is no longer a shape of paste that can skip this check.
 */
export function assertPastedState(parsed: PastedAuthorization, expected: string): void {
  if (parsed.state !== expected) {
    throw new PastedStateMismatchError(
      'the authorization code you pasted came back with a different "state" than this sign-in sent. ' +
        'That can mean the code belongs to another sign-in attempt, or that the redirect was tampered with. ' +
        'Start the sign-in again rather than reusing this code.',
    );
  }
}

/**
 * Parse the user's pasted input on the paste method. Two accepted shapes, both
 * carrying `state`:
 *   1. the full redirect URL the browser landed on (or failed to load),
 *      `…/callback?code=…&state=…`;
 *   2. `code#state` — what the hosted callback page displays.
 *
 * A BARE CODE IS REFUSED (round 2, PLAN §3.1). It was previously accepted and
 * passed `state` verification vacuously, which is the one paste shape that
 * cannot be checked at all — so the affordance is withdrawn rather than
 * guarded, and the message tells the user exactly what to paste instead.
 * Throws a plain `Error` for empty input, an unparseable URL, a URL missing
 * either half, or a bare code.
 */
export function parsePastedCode(input: string): PastedAuthorization {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Paste the code or address from your browser first.');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (error) {
      // The input is NOT echoed: on the paste method it is the redirect URL,
      // which carries a live authorization code, and this string is rendered
      // into the sign-in page's DOM.
      throw new Error("That address couldn't be read. Copy the whole thing from the address bar.", {
        cause: error,
      });
    }

    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      throw new Error('That address is missing part of the sign-in. Copy the whole thing from the address bar.');
    }
    const state = url.searchParams.get('state');
    if (state === null || state === '') {
      throw new Error('That address is missing part of the sign-in. Copy the whole thing from the address bar.');
    }
    return { code, state };
  }

  // `code#state`. Split on the FIRST '#' only: the code is opaque and could
  // itself contain one, and a trailing fragment would silently truncate state.
  const hash = trimmed.indexOf('#');
  if (hash === -1) {
    throw new Error(PASTE_NEEDS_BOTH_PARTS);
  }
  const code = trimmed.slice(0, hash).trim();
  const state = trimmed.slice(hash + 1).trim();
  if (code === '' || state === '') {
    throw new Error(PASTE_NEEDS_BOTH_PARTS);
  }
  return { code, state };
}
