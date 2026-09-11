import { ENVIRONMENTS } from './environments.js';
import { decodeJwtExpiry, readCurrentToken, readRefreshToken, writeToken } from './credentials.js';
import { refreshAccessToken } from './pkce.js';
import { resolveOAuthProvider } from './oauth-provider.js';

/**
 * Spend a stored refresh token to replace an access token that is expiring.
 *
 * Until this existed the refresh half of the OAuth flow was written and tested
 * but never called: `offline_access` was requested, the refresh token was
 * stored, and nothing ever redeemed it. An expiring session simply died and
 * the user signed in again.
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by the
 * CLI and the extension.
 */

/**
 * Refresh this far ahead of expiry.
 *
 * Wider than the 30s the credential gate rejects at, so the ordinary path is
 * "refresh in the background well before anything is rejected" rather than
 * "wait for a request to fail, then scramble".
 */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

export interface RefreshOutcome {
  /** The replacement access token, when one was obtained. */
  readonly token?: string;
  /** Why nothing happened, for logging. Never contains a token. */
  readonly reason: 'refreshed' | 'not-needed' | 'no-refresh-token' | 'no-client-id' | 'failed' | 'raced';
  /** The refresh failure, if `reason` is 'failed'. Never contains a token. */
  readonly error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Milliseconds until `token` expires, or undefined when it carries no `exp`. */
function remainingMs(token: string): number | undefined {
  const expiry = decodeJwtExpiry(token);
  return expiry === undefined ? undefined : expiry.getTime() - Date.now();
}

/**
 * Refresh `env`'s access token if it is close to expiry and a refresh token is
 * stored for it.
 *
 * Never throws. Every failure is reported through {@link RefreshOutcome} so a
 * caller can log it and carry on with whatever it already had: a refresh that
 * did not work must not be worse than no refresh attempt at all.
 *
 * @param currentToken the token on disk now
 * @param apiBase      the environment's API base, for the RFC 8707 resource indicator
 */
export async function refreshIfExpiring(env: string, currentToken: string, apiBase: string): Promise<RefreshOutcome> {
  const remaining = remainingMs(currentToken);
  // No `exp` means an opaque or non-expiring token; there is nothing to act on.
  if (remaining === undefined || remaining > REFRESH_LEAD_MS) return { reason: 'not-needed' };

  const refreshToken = await readRefreshToken(env).catch(() => undefined);
  if (refreshToken === undefined) return { reason: 'no-refresh-token' };

  const clientId = ENVIRONMENTS[env]?.clientId;
  // An environment with no CIMD identity has no OAuth at all (sandbox), so it
  // can never have obtained a refresh token in the first place.
  if (clientId === undefined) return { reason: 'no-client-id' };

  let provider;
  try {
    provider = resolveOAuthProvider(env, apiBase);
  } catch (error) {
    return { reason: 'failed', error: errorMessage(error) };
  }

  try {
    const response = await refreshAccessToken(provider.issuerBase, {
      clientId: provider.clientId,
      refreshToken,
      resource: provider.resource,
    });

    // Rotation is ON tenant-side: this response carries a REPLACEMENT refresh
    // token and the one just spent is now dead. Persisting both together is
    // what keeps the next refresh possible.
    await writeToken(env, response.access_token, apiBase, response.refresh_token);
    return { token: response.access_token, reason: 'refreshed' };
  } catch (error) {
    // With rotation on, a concurrent refresh by another process (a second IDE,
    // the CLI alongside the proxy) invalidates the token this call was holding
    // and lands here. The winner has already written a good token, so look
    // before concluding anything is broken.
    const onDisk = await readCurrentToken(env).catch(() => undefined);
    if (onDisk !== undefined && onDisk !== currentToken) {
      const freshRemaining = remainingMs(onDisk);
      if (freshRemaining === undefined || freshRemaining > 0) return { token: onDisk, reason: 'raced' };
    }
    return { reason: 'failed', error: errorMessage(error) };
  }
}
