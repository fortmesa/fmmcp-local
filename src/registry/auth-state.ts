import { DEFAULT_API_BASE, ENVIRONMENTS } from './environments.js';
import { readCredentialsSummary, readCurrentToken, readStoredApiBase } from './credentials.js';
import { refreshIfExpiring } from './token-refresh.js';

/**
 * The single answer to "is this environment signed in?" (MFDV-581).
 *
 * The status bar and the Signed-in user pane used to answer it differently:
 * the pane went through `resolveCredentials`, which renews an expiring token
 * before judging it, while the bar read credentials.json raw and judged the
 * expired token it found there. The bar therefore said "Not signed-in" during
 * exactly the window in which a refresh was possible, and never heard about
 * the refresh the pane then made. Every surface now asks here: a refresh is
 * attempted first, and a completed refresh is announced through
 * `identity-events.ts` (`onAuthRefreshed`).
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by the
 * CLI and the extension.
 */
export interface AuthState {
  readonly hasToken: boolean;
  /** The stored token has provably expired AND could not be renewed. */
  readonly expired: boolean;
  /** `hasToken` and not `expired`. */
  readonly signedIn: boolean;
}

/** Read `env`'s auth state, renewing the access token first when a refresh token makes that possible. Never renews a token that has plenty of life left. Rejects only when credentials.json cannot be read. */
export async function readAuthState(env: string): Promise<AuthState> {
  let summary = await readCredentialsSummary(env);
  if (summary.hasToken) {
    const token = await readCurrentToken(env);
    if (token !== undefined) {
      const apiBase = (await readStoredApiBase(env)) ?? ENVIRONMENTS[env]?.api ?? DEFAULT_API_BASE;
      const outcome = await refreshIfExpiring(env, token, apiBase);
      if (outcome.reason === 'refreshed' || outcome.reason === 'raced') summary = await readCredentialsSummary(env);
    }
  }
  const expired = summary.hasToken && summary.expired === true;
  return { hasToken: summary.hasToken, expired, signedIn: summary.hasToken && !expired };
}
