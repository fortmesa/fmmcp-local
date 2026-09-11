import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { resolveCredentials } from '../local-mcp/auth/token-provider.js';
import {
  decodeJwtExpiry,
  fetchIdentity,
  identityPrimaryLabel,
  readCachedIdentity,
  writeCachedIdentity,
  writeToken,
  type Identity,
} from '../registry/credentials.js';
import { ENVIRONMENTS, completionUrl, type SignInCompletionOutcome } from '../registry/environments.js';
import {
  LOOPBACK_PORTS,
  LoopbackAbortedError,
  LoopbackStateMismatchError,
  LoopbackTimeoutError,
  PastedStateMismatchError,
  assertPastedState,
  loopbackRedirectUri,
  parsePastedCode,
  runLocalLoopbackFlow,
} from '../registry/oauth-flow.js';
import { resolveOAuthProvider, type OAuthProvider } from '../registry/oauth-provider.js';
import {
  authorizeIntentParams,
  chooseDefaultMethod,
  isLoopbackExternalUri,
  type MethodChoice,
  type SignInIntent,
  type SignInMethod,
} from '../registry/sign-in-method.js';
import { buildAuthorizeUrl, exchangeCodeForToken, generatePkcePair } from '../registry/pkce.js';
import { browserOpenUrl } from '../registry/first-land.js';
import type { SignInFailureKind } from '../registry/sign-in-page-state.js';
import { notifyIdentityChanged } from '../registry/identity-events.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * The sign-in TRANSPORT, as a session object the sign-in page drives
 * (BRIEF-SIGNIN-1 step 8; PLAN-vsix-signin.md §3).
 *
 * Everything the user sees lives in the dedicated sign-in page (SIGNIN-2).
 * Nothing here opens an input box or a quick pick: this module runs OAuth,
 * emits what happened, and exposes the three verbs the page needs
 * (`cancel`, `submitPasted`, `copyLink`). Keeping the UI out
 * of it is what makes the "paste rescue" of PLAN §3.1 possible at all — the
 * page can offer the paste field UNDERNEATH a running browser flow, and
 * whichever path completes first wins, with no mode switch and no restart.
 *
 * Why a session object rather than one `await`: the browser method is a
 * long-lived wait with live affordances (re-open, copy, cancel, rescue-paste)
 * and multiple non-exceptional outcomes (`cancelled`, `wrong-account`). A
 * promise can express exactly one of those.
 */

/** Reported once the browser has been sent to Auth0 and the session is waiting. `expiresAt` is epoch ms so the page can render its own countdown without a clock of its own. */
export interface SignInWaitingEvent {
  readonly type: 'waiting';
  readonly authorizeUrl: string;
  readonly expiresAt: number;
  readonly method: SignInMethod;
  /** True when this environment has a hosted callback page listed — i.e. the paste method shows a real `code#state` page rather than the browser's own "can't be reached" error. */
  readonly hostedPageLive: boolean;
}

export interface SignInSuccessEvent {
  readonly type: 'success';
  readonly identity: Identity | undefined;
  readonly expiry: Date | undefined;
}

export interface SignInCancelledEvent {
  readonly type: 'cancelled';
}

export interface SignInErrorEvent {
  readonly type: 'error';
  readonly message: string;
  /**
   * Why it failed, as a code the sign-in page turns into copy (SIGNIN-9).
   *
   * Additive and optional: the transport sets it at every emit site, and a
   * consumer that ignores it behaves exactly as before. It exists because
   * `message` is an exception string — rendering it put "timed out after
   * 120000ms waiting for the OAuth callback." in front of the user on the
   * single most likely failure path in the flow.
   */
  readonly kind?: SignInFailureKind;
}

/**
 * The user asked to continue as one account and came back as another.
 *
 * The token IS kept and written — it is a valid grant for a real user, and
 * throwing it away would force a second full sign-in to use it. The page
 * decides between "Keep <actual>" and "Switch account"; the transport does not
 * get to make that call, and must not silently treat it as success either
 * (silence here is how a user ends up acting on the wrong tenant's data).
 */
export interface SignInWrongAccountEvent {
  readonly type: 'wrong-account';
  readonly intended: string;
  readonly actual: string;
  readonly identity: Identity;
  readonly expiry: Date | undefined;
}

export type SignInEvent =
  SignInWaitingEvent | SignInSuccessEvent | SignInCancelledEvent | SignInErrorEvent | SignInWrongAccountEvent;

export interface SignInSession {
  readonly env: string;
  readonly method: SignInMethod;
  /** Subscribe. Terminal events fire at most once; `waiting` fires once, first. */
  readonly onEvent: (listener: (event: SignInEvent) => void) => vscode.Disposable;
  /**
   * The terminal event, as a promise — for callers that only want the answer
   * (the command shim) rather than the live states the page renders. Resolves
   * immediately if the session has already finished.
   */
  readonly outcome: () => Promise<Exclude<SignInEvent, SignInWaitingEvent>>;
  /** Abandon the sign-in: aborts the loopback listener and emits `cancelled`. Idempotent. */
  readonly cancel: () => void;
  /** Complete the sign-in from pasted input (the paste method, and the rescue field under a running browser flow). */
  readonly submitPasted: (text: string) => void;
  /**
   * Copy the authorize URL to the clipboard. No-op before `waiting`.
   *
   * Host-side on purpose: a webview's own `navigator.clipboard` is not
   * dependable, and the page's read-only link field is the manual fallback
   * when even this fails.
   */
  readonly copyLink: () => Promise<void>;
}

/** How long the browser has to come back before the session gives up. */
const SIGN_IN_TIMEOUT_MS = 120000;

const LAST_METHOD_KEY_PREFIX = 'saferoom.lastSignInMethod.';

/**
 * Per-machine memory of the last sign-in method that WORKED, keyed by
 * `vscode.env.remoteName ?? 'local'`.
 *
 * The key carries the remote name because the answer is a property of the
 * topology, not of the user: the same person on the same workstation gets a
 * different correct answer for a local window and a Remote-SSH one, and a
 * single shared key would have each connection undo the other's memory.
 * `globalState` (not workspace state) because it is equally true of every
 * folder they open.
 */
export interface SignInMethodMemory {
  readonly get: () => SignInMethod | undefined;
  readonly remember: (method: SignInMethod) => Promise<void>;
}

export function signInMethodMemory(
  globalState: vscode.Memento,
  remoteName: string = vscode.env.remoteName ?? 'local',
): SignInMethodMemory {
  const key = `${LAST_METHOD_KEY_PREFIX}${remoteName}`;
  return {
    get: () => {
      const stored = globalState.get<string>(key);
      return stored === 'browser' || stored === 'paste' ? stored : undefined;
    },
    remember: async (method) => {
      await globalState.update(key, method);
    },
  };
}

/**
 * Can a loopback redirect actually reach this extension host from the user's
 * browser? Answered by ASKING the host to externalise a loopback URL and
 * checking what comes back (`asExternalUri` forwards it under a remote host;
 * a web-hosted editor or a public tunnel returns something that is not
 * loopback, and we take that at face value rather than rewriting it).
 *
 * Never throws: any failure means "cannot forward", which pre-selects the
 * paste method — the method that works everywhere.
 */
export async function detectLoopbackForwardable(port: number = LOOPBACK_PORTS[0]): Promise<boolean> {
  if (vscode.env.uiKind === vscode.UIKind.Web) return false;
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${String(port)}`));
    return isLoopbackExternalUri(external.toString(true));
  } catch {
    return false;
  }
}

/** The page's landing state: which method to pre-select and why, plus the identity to offer "Continue as". */
export interface SignInLanding {
  readonly choice: MethodChoice;
  readonly cachedIdentity: { readonly email: string; readonly displayName: string } | undefined;
  readonly hostedPageLive: boolean;
  /** False for a token-only environment (sandbox has no CIMD client): the page shows the paste-a-token notice instead of the sign-in buttons. */
  readonly oauthAvailable: boolean;
  /**
   * The API base this sign-in will use, or `undefined` for an environment
   * Saferoom has never heard of and has no credentials for.
   *
   * Added for SIGNIN-2 (documented addition, brief STOP rule): the unknown-env
   * API-base question used to be a `showInputBox` in `login-command.ts`, and
   * the PO moved every sign-in question onto the page. The page can only draw
   * that field if it is told the answer is missing, and asking it to re-derive
   * the answer would duplicate the precedence order (stored credentials, then
   * the built-in default) in a second place.
   */
  readonly apiBase: string | undefined;
}

/** Everything the sign-in page needs before it renders — gathered here so the page holds no `vscode.env` logic of its own. */
export async function resolveSignInLanding(env: string, memory?: SignInMethodMemory): Promise<SignInLanding> {
  const forwardable = await detectLoopbackForwardable();
  const choice = chooseDefaultMethod({
    forwardable,
    uiKindWeb: vscode.env.uiKind === vscode.UIKind.Web,
    remembered: memory?.get(),
  });
  return {
    choice,
    cachedIdentity: await readCachedIdentity(env),
    hostedPageLive: ENVIRONMENTS[env]?.hostedCallback !== undefined,
    oauthAvailable: ENVIRONMENTS[env]?.clientId !== undefined,
    apiBase: await resolveApiBaseQuietly(env),
  };
}

/**
 * Resolve the API base for `env` without prompting: the stored credentials
 * first (a user-customised base must survive a re-login), then the built-in
 * default. A caller that CAN prompt — the command shim, for an environment
 * Saferoom has never heard of — passes the answer in as `apiBase`.
 */
async function resolveApiBaseQuietly(env: string): Promise<string | undefined> {
  try {
    // allowExpired: this reads baseUrl only, on the way INTO a fresh sign-in.
    // Refusing because the stored token is dead would discard the very API
    // base the new login needs.
    const creds = await resolveCredentials(env, { allowExpired: true });
    return creds.baseUrl;
  } catch {
    const known = ENVIRONMENTS[env]?.api;
    return known !== undefined && known !== '' ? known : undefined;
  }
}

export interface StartSignInOptions {
  /** An API base the caller already resolved (e.g. by prompting for an unknown environment). Skips {@link resolveApiBaseQuietly}. */
  readonly apiBase?: string;
  readonly memory?: SignInMethodMemory;
  readonly timeoutMs?: number;
  /**
   * Open the authorize URL in the user's browser once it is built. Default
   * `true`.
   *
   * `false` PREPARES the session and stops: it builds the URL, emits
   * `waiting`, and waits for a paste. The sign-in page needs this because
   * selecting the code-based card must show the real authorize URL — the one a
   * copy would put on the clipboard — and selecting a card is not a request to
   * launch anything. The URL is inert until somebody visits it.
   */
  readonly openBrowser?: boolean;
}

/**
 * Start a sign-in. Returns immediately with a session; everything else arrives
 * as events.
 *
 * `options` is additive to the signature BRIEF-SIGNIN-1 §8 specifies
 * (`startSignIn(env, intent, method, log)` still works verbatim) — it exists
 * so the method memory and the prompted API base can be INJECTED rather than
 * reached for through module state, which is also what makes the transport
 * testable without an extension host.
 */
export function startSignIn(
  env: string,
  intent: SignInIntent,
  method: SignInMethod,
  log: Logger,
  options: StartSignInOptions = {},
): SignInSession {
  const emitter = new vscode.EventEmitter<SignInEvent>();
  const abort = new AbortController();
  let authorizeUrl: string | undefined;
  let finished = false;
  /** Resolved by `submitPasted`. On the browser method this races the loopback listener — the rescue path of PLAN §3.1. */
  let deliverPaste: ((text: string) => void) | undefined;
  const pastePromise = new Promise<string>((resolve) => {
    deliverPaste = resolve;
  });

  // Late subscribers get the story so far. Without this the page can MISS the
  // `waiting` event outright: when the API base is already known, `run()`
  // reaches `announce()` with no await in between, so the event fires before
  // `startSignIn` has even returned the session to subscribe to. Replaying is
  // the fix rather than merely deferring the start, because the page also
  // re-subscribes when its webview is hidden and restored, and a sign-in in
  // flight must still be describable then.
  let waitingEvent: SignInWaitingEvent | undefined;
  let terminalEvent: Exclude<SignInEvent, SignInWaitingEvent> | undefined;

  const emit = (event: SignInEvent): void => {
    if (event.type === 'waiting') {
      waitingEvent = event;
    } else {
      if (finished) return;
      finished = true;
      terminalEvent = event;
    }
    emitter.fire(event);
  };

  const run = async (): Promise<void> => {
    const apiBase = options.apiBase ?? (await resolveApiBaseQuietly(env));
    if (apiBase === undefined) {
      emit({
        type: 'error',
        message: `Saferoom does not know the API base URL for environment "${env}" — set it in Settings › Advanced before signing in.`,
        kind: 'no-api-base',
      });
      return;
    }

    let provider: OAuthProvider;
    try {
      provider = resolveOAuthProvider(env, apiBase);
    } catch (error) {
      emit({ type: 'error', message: errorMessage(error), kind: 'not-configured' });
      return;
    }

    const { verifier, challenge } = generatePkcePair();
    const state = randomBytes(16).toString('hex');
    const hostedCallback = ENVIRONMENTS[env]?.hostedCallback;

    const buildUrl = (redirectUri: string): string =>
      buildAuthorizeUrl(provider.issuerBase, {
        clientId: provider.clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
        resource: provider.resource,
        scope: provider.scope,
        ...authorizeIntentParams(intent),
      });

    const announce = (url: string): void => {
      authorizeUrl = url;
      emit({
        type: 'waiting',
        authorizeUrl: url,
        expiresAt: Date.now() + (options.timeoutMs ?? SIGN_IN_TIMEOUT_MS),
        method,
        hostedPageLive: hostedCallback !== undefined,
      });
      // The browser goes to the FortMesa first-land page where the
      // environment has one (identity choice before Auth0 consent, PO
      // 2026-09-09); `url` — the real authorize URL — is what the page's
      // "copy the link" field still hands out, because that link is for
      // finishing in a DIFFERENT browser, where no FortMesa session exists
      // for the start page to show an identity from.
      if (options.openBrowser !== false) void vscode.env.openExternal(vscode.Uri.parse(browserOpenUrl(env, url)));
    };

    /** Exchange, persist, identify. `respond` (browser method only) sends the waiting browser to the "You're all set" page once the outcome is known. */
    const complete = async (code: string, redirectUri: string, respond?: (location: string) => void): Promise<void> => {
      let outcome: SignInCompletionOutcome = 'error';
      try {
        const tokenResponse = await exchangeCodeForToken(provider.issuerBase, {
          clientId: provider.clientId,
          redirectUri,
          code,
          codeVerifier: verifier,
          resource: provider.resource,
        });
        await writeToken(env, tokenResponse.access_token, apiBase, tokenResponse.refresh_token);
        const expiry = decodeJwtExpiry(tokenResponse.access_token);

        // credentials.json has no watcher (only config.json does), so the tree
        // views never learn a token appeared without this.
        await vscode.commands.executeCommand('fortmesa.refresh');

        const identity = await fetchIdentity(apiBase, tokenResponse.access_token);
        if (identity !== undefined) {
          await writeCachedIdentity(env, { email: identity.email, displayName: identity.displayName });
        }

        // ...and the two WEBVIEW panels never learn it either, which
        // `fortmesa.refresh` does not fix — it refreshes the three trees only.
        // That is the gap the identity event closes (see
        // `identity-events.ts`). Fired here rather than beside the refresh
        // above so it can carry the identity's label: the panel says who it
        // reloaded for, and must not make a network call of its own to find out.
        notifyIdentityChanged({
          kind: 'signed-in',
          env,
          ...(identity !== undefined ? { label: identityPrimaryLabel(identity) } : {}),
        });
        await options.memory?.remember(method);
        outcome = 'ok';

        if (
          intent.mode === 'continue' &&
          identity !== undefined &&
          identity.email.toLowerCase() !== intent.email.toLowerCase()
        ) {
          log.info(`fortmesa.login: signed in for "${env}" as a different account than the one continued from.`);
          emit({ type: 'wrong-account', intended: intent.email, actual: identity.email, identity, expiry });
          return;
        }

        log.info(`fortmesa.login: signed in for "${env}"`);
        emit({ type: 'success', identity, expiry });
      } catch (error) {
        emit({ type: 'error', message: errorMessage(error), kind: 'exchange-failed' });
      } finally {
        respond?.(completionUrl(env, outcome));
      }
    };

    /** Parse + verify a paste, then complete. A state mismatch is a hard stop on this path too. */
    const completeFromPaste = async (
      text: string,
      redirectUri: string,
      respond?: (location: string) => void,
    ): Promise<void> => {
      try {
        const parsed = parsePastedCode(text);
        assertPastedState(parsed, state);
        await complete(parsed.code, redirectUri, respond);
      } catch (error) {
        respond?.(completionUrl(env, 'error'));
        emit({
          type: 'error',
          message: errorMessage(error),
          kind: error instanceof PastedStateMismatchError ? 'state-mismatch' : 'bad-paste',
        });
      }
    };

    if (method === 'paste') {
      // The hosted page when the environment has one listed in its CIMD;
      // otherwise the loopback URL, where the browser lands on its own
      // "can't be reached" page and the user copies the address (PLAN §3.2).
      const redirectUri = hostedCallback ?? loopbackRedirectUri(LOOPBACK_PORTS[0]);
      announce(buildUrl(redirectUri));
      const text = await Promise.race([
        pastePromise,
        new Promise<never>((_, rejectRace) => {
          abort.signal.addEventListener('abort', () => {
            rejectRace(new LoopbackAbortedError('cancelled'));
          });
        }),
      ]).catch((error: unknown) => {
        if (error instanceof LoopbackAbortedError) return undefined;
        throw error;
      });
      if (text === undefined) return; // cancelled — `cancel()` already emitted.
      await completeFromPaste(text, redirectUri);
      return;
    }

    // Browser method: a loopback listener, with the paste field still live
    // underneath it as the rescue path.
    let pasteRedirectUri = hostedCallback ?? loopbackRedirectUri(LOOPBACK_PORTS[0]);
    try {
      const flow = await Promise.race([
        runLocalLoopbackFlow({
          apiBase: provider.issuerBase,
          clientId: provider.clientId,
          log: (message) => {
            log.info(message);
          },
          expectedState: state,
          resolveRedirectUri: async (boundPort) => {
            const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${String(boundPort)}`));
            // `.toString(true)` keeps the URI unencoded; the trailing-slash
            // trim keeps the path exactly `/callback` either way.
            const base = external.toString(true).replace(/\/+$/, '');
            pasteRedirectUri = `${base}/callback`;
            return pasteRedirectUri;
          },
          onRedirectUriReady: (redirectUri) => {
            announce(buildUrl(redirectUri));
          },
          fallbackRedirect: completionUrl(env, 'error'),
          signal: abort.signal,
          timeoutMs: options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
        }),
        pastePromise.then((text) => ({ pasted: text }) as const),
      ]);

      if ('pasted' in flow) {
        // The rescue path won: the loopback listener is left to its own
        // timeout, which is harmless — nothing will arrive on it now.
        await completeFromPaste(flow.pasted, pasteRedirectUri);
        return;
      }

      if (flow.outcome === 'cancelled') {
        flow.respond(completionUrl(env, 'cancelled'));
        emit({ type: 'cancelled' });
        return;
      }
      if (flow.outcome === 'error' || flow.code === undefined) {
        flow.respond(completionUrl(env, 'error'));
        emit({
          type: 'error',
          message: flow.errorDescription ?? 'the sign-in did not complete.',
          kind: 'provider-refused',
        });
        return;
      }
      await complete(flow.code, flow.usedRedirectUri, flow.respond);
    } catch (error) {
      if (error instanceof LoopbackAbortedError) return; // `cancel()` already emitted.
      if (error instanceof LoopbackStateMismatchError || error instanceof PastedStateMismatchError) {
        emit({ type: 'error', message: errorMessage(error), kind: 'state-mismatch' });
        return;
      }
      // The two-minute timeout is the likeliest failure of all, and the one
      // whose raw message ("timed out after 120000ms waiting for the OAuth
      // callback.") was being shown to users verbatim.
      if (error instanceof LoopbackTimeoutError) {
        emit({ type: 'error', message: errorMessage(error), kind: 'timeout' });
        return;
      }
      emit({ type: 'error', message: errorMessage(error), kind: 'unknown' });
    }
  };

  void run().catch((error: unknown) => {
    log.error(`fortmesa sign-in failed unexpectedly: ${errorMessage(error)}`);
    emit({ type: 'error', message: errorMessage(error), kind: 'unknown' });
  });

  return {
    env,
    method,
    onEvent: (listener) => {
      const subscription = emitter.event(listener);
      if (waitingEvent !== undefined) listener(waitingEvent);
      if (terminalEvent !== undefined) listener(terminalEvent);
      return subscription;
    },
    outcome: () =>
      new Promise((resolve) => {
        if (terminalEvent !== undefined) {
          resolve(terminalEvent);
          return;
        }
        // Subscribed to the emitter directly, NOT through `onEvent`: the
        // replay in `onEvent` can fire synchronously, and a listener that
        // disposes its own not-yet-assigned handle would throw.
        const sub = emitter.event((event) => {
          if (event.type === 'waiting') return;
          sub.dispose();
          resolve(event);
        });
      }),
    cancel: () => {
      if (finished) return;
      abort.abort();
      emit({ type: 'cancelled' });
    },
    submitPasted: (text) => {
      deliverPaste?.(text);
    },
    copyLink: async () => {
      if (authorizeUrl === undefined) return;
      await vscode.env.clipboard.writeText(authorizeUrl);
    },
  };
}
