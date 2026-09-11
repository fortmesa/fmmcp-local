/**
 * Sign-in method and intent — the two pure decisions the sign-in page and the
 * transport both have to agree on, kept out of both so they can be tested
 * without a VS Code host and reused by the CLI later.
 *
 * `src/registry/**` stays `vscode`-free (VSIX-PLAN.md §3.1): this module takes
 * the topology it needs as plain booleans, and `extension/sign-in-session.ts`
 * is what reads `vscode.env` to produce them.
 */

/**
 * How the authorization code gets from the browser back to the editor
 * (PLAN §3.1). Both methods are always VISIBLE on the sign-in page; this type
 * is only about which one is pre-selected and which `redirect_uri` is sent.
 *
 * - `browser` — a loopback listener on the extension host, reached through the
 *   forwarded URI. One hop, nothing for the user to do.
 * - `paste` — the user copies the code (or the whole redirect address) out of
 *   the browser. Works in every topology, including a browser that cannot
 *   reach the extension host at all.
 */
export type SignInMethod = 'browser' | 'paste';

/** Why {@link chooseDefaultMethod} chose what it chose. The page owns the copy; this is the reason CODE, so wording changes never touch this module or its tests. */
export type SignInMethodReason =
  | 'remembered' // this method succeeded last time on this machine
  | 'forwardable' // the browser can reach the extension host from here
  | 'not-forwardable' // it cannot, so the code has to come back by hand
  | 'web'; // a browser-hosted editor: no loopback listener is possible at all

export interface MethodTopology {
  /** A loopback redirect can be forwarded: `asExternalUri` returned a loopback host. */
  readonly forwardable: boolean;
  /** `vscode.env.uiKind === UIKind.Web` — the editor itself runs in a browser tab. */
  readonly uiKindWeb: boolean;
  /** The method last remembered as having WORKED on this machine, if any. */
  readonly remembered?: SignInMethod | undefined;
}

export interface MethodChoice {
  readonly method: SignInMethod;
  readonly reason: SignInMethodReason;
}

/**
 * Pre-select a sign-in method from the detected topology (PLAN §3.1).
 *
 * Order matters and each step earns its place:
 *   1. A web-hosted editor can never bind a loopback listener the user's
 *      browser could reach — `paste`, regardless of anything remembered.
 *   2. A remembered method wins next: it is the only evidence that is about
 *      THIS machine rather than about what the API reports. But a remembered
 *      `browser` is still discarded when forwarding is no longer available
 *      (the user moved from local to a remote host) — memory of a success
 *      must not override a live signal that it cannot succeed now.
 *   3. Otherwise: `browser` when forwardable, `paste` when not.
 *
 * Pure by construction so the whole matrix is a unit test.
 */
export function chooseDefaultMethod(topology: MethodTopology): MethodChoice {
  if (topology.uiKindWeb) return { method: 'paste', reason: 'web' };

  if (topology.remembered === 'paste') return { method: 'paste', reason: 'remembered' };
  if (topology.remembered === 'browser' && topology.forwardable) {
    return { method: 'browser', reason: 'remembered' };
  }

  return topology.forwardable
    ? { method: 'browser', reason: 'forwardable' }
    : { method: 'paste', reason: 'not-forwardable' };
}

/** The loopback hosts a forwarded URI may legitimately resolve to. Anything else means the browser will not be talking to our listener. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is `externalUri` still pointing at this machine's loopback interface?
 *
 * `asExternalUri` is documented to return a forwarded `localhost:<port>` under
 * a remote host, but it is equally allowed to return a PUBLIC tunnel host
 * (vscode.dev / a devtunnel). A public host is not a redirect we may use: it
 * is not a loopback address, so Auth0's loopback exemption does not cover it,
 * and it would put the authorization code through a third party. In that case
 * the browser method is simply not available and the paste method is
 * pre-selected — we never rewrite the host to force it (BRIEF STOP rule).
 */
export function isLoopbackExternalUri(externalUri: string): boolean {
  let url: URL;
  try {
    url = new URL(externalUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * What the user asked for on the landing page (PLAN §3.1):
 * - `continue` — "Continue as <email>": pre-fill that identity (`login_hint`)
 *   and treat coming back as somebody else as a WRONG-ACCOUNT outcome rather
 *   than a silent success.
 * - `switch` — "Use a different account": force re-authentication
 *   (`prompt=login`), because an existing tenant SSO session would otherwise
 *   hand back the very identity the user is trying to leave.
 * - `fresh` — no cached identity; plain sign-in.
 */
export type SignInIntent =
  { readonly mode: 'continue'; readonly email: string } | { readonly mode: 'switch' } | { readonly mode: 'fresh' };

/** The `prompt` / `login_hint` pair an intent implies, ready to spread into {@link import('./pkce.js').AuthorizeUrlParams}. */
export function authorizeIntentParams(intent: SignInIntent): {
  prompt?: 'login';
  loginHint?: string;
} {
  switch (intent.mode) {
    case 'continue':
      return { loginHint: intent.email };
    case 'switch':
      return { prompt: 'login' };
    case 'fresh':
      return {};
  }
}
