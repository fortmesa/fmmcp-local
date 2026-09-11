import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { writeToken } from './credentials.js';
import { completionUrl } from './environments.js';
import { loopbackRedirectUri, runLocalLoopbackFlow } from './oauth-flow.js';
import { buildAuthorizeUrl, exchangeCodeForToken, generatePkcePair } from './pkce.js';
import type { OAuthProvider } from './oauth-provider.js';

/**
 * The loopback half of the CIMD sign-in, with nothing terminal-specific in it.
 *
 * Two callers need this and they disagree about almost everything else. The
 * `login` subcommand runs in a terminal, can prompt on stdin, and prints to
 * stdout. The MCP proxy runs as a stdio server where STDOUT IS THE JSON-RPC
 * CHANNEL and stdin is the client's half of it, so it can neither print nor
 * prompt. Both still need the same PKCE exchange, so it lives here and each
 * caller supplies its own `notify`.
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by the
 * CLI and the extension.
 */

export interface LoopbackLoginOptions {
  /**
   * Where progress goes. The proxy MUST pass a stderr writer: a single stray
   * byte on stdout corrupts the JSON-RPC stream and the host drops the server.
   */
  readonly notify: (message: string) => void;
  /** Ask the OS to open the authorize URL. Off by default, since a terminal user is already looking at it. */
  readonly launchBrowser?: boolean;
  /** Seconds to wait for the browser redirect. */
  readonly timeoutMs?: number;
}

/**
 * Hand the authorize URL to the desktop's default browser.
 *
 * Best effort by design: a headless box has nothing to open, and the URL is
 * always logged as well, so a failure here is not a failure of the sign-in.
 * `detached` + `unref` keeps the browser from holding the proxy's event loop
 * open, and both pipes are ignored so a chatty launcher cannot write into
 * stdout.
 */
export function openBrowser(url: string): boolean {
  // Headless boxes, CI, and the .mcpb build's own smoke test all need the
  // sign-in path exercised WITHOUT a browser window appearing.
  if (process.env.FMCODE_NO_BROWSER === 'true') return false;

  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // A launcher that fails asynchronously must not surface as an unhandled
    // error event on the proxy.
    child.on('error', () => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run Authorization Code + PKCE against `provider` over a loopback redirect,
 * then persist the resulting tokens for `env`.
 *
 * Throws on every failure, including the state mismatch that
 * `runLocalLoopbackFlow` raises: callers decide whether some other path is
 * worth trying. The refresh token from the response is stored alongside the
 * access token, which is what lets `token-refresh.ts` renew later instead of
 * forcing another sign-in.
 */
export async function loopbackLogin(
  provider: OAuthProvider,
  env: string,
  apiBase: string,
  options: LoopbackLoginOptions,
): Promise<void> {
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(16).toString('hex');

  const result = await runLocalLoopbackFlow({
    apiBase: provider.issuerBase,
    clientId: provider.clientId,
    log: options.notify,
    expectedState: state,
    // The CLI and the proxy run on the same machine as the browser they
    // launch, so the loopback URL is already externally visible — there is no
    // extension host to forward through (that is the VSIX's problem, and the
    // reason this is now a caller-supplied value at all).
    resolveRedirectUri: (boundPort) => loopbackRedirectUri(boundPort),
    onRedirectUriReady: (redirectUri) => {
      const url = buildAuthorizeUrl(provider.issuerBase, {
        clientId: provider.clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
        resource: provider.resource,
        scope: provider.scope,
      });

      if (options.launchBrowser === true && openBrowser(url)) {
        options.notify(`Opened a browser to sign in to env "${env}". Waiting for the redirect back...`);
      }
      // Logged whether or not the browser opened. When it did not, this line
      // is the only way the user reaches the URL at all.
      options.notify(`Sign-in URL: ${url}`);
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  // The browser is held on /callback until the exchange has run, so it can be
  // told what actually happened rather than a fixed "something happened" page.
  // The CLI sends it to the same "You're all set" route the extension does.
  if (result.outcome !== 'success' || result.code === undefined) {
    result.respond(completionUrl(env, result.outcome === 'cancelled' ? 'cancelled' : 'error'));
    throw new Error(
      result.outcome === 'cancelled'
        ? 'the sign-in was cancelled in the browser.'
        : `the sign-in did not complete (${result.errorDescription ?? 'no authorization code was returned'}).`,
    );
  }

  const tokenResponse = await exchangeCodeForToken(provider.issuerBase, {
    clientId: provider.clientId,
    redirectUri: result.usedRedirectUri,
    code: result.code,
    codeVerifier: verifier,
    resource: provider.resource,
  });

  try {
    await writeToken(env, tokenResponse.access_token, apiBase, tokenResponse.refresh_token);
  } catch (error) {
    result.respond(completionUrl(env, 'error'));
    throw error;
  }
  result.respond(completionUrl(env, 'ok'));
}
