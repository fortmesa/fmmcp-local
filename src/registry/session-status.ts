import { ENVIRONMENTS, environmentLabel } from './environments.js';

/**
 * The expired-session state for the **Signed-in user** pane (PO,
 * 2026-09-05: "The VSIX doesn't handle expired tokens well, when a token is
 * expired it should prompt the user to refresh their session in the signed
 * in user pane in some way").
 *
 * Before this, an expired credential was invisible in the UI: the pane still
 * read "Signed in", with the expiry demoted to a muted `expires <relative>`
 * suffix that `formatRelativeExpiry` renders as the single word "expired".
 * The credential gate in `local-mcp/auth/token-provider.ts` refused it and
 * every tool call died, but nothing told the user to do anything about it.
 *
 * Deliberately free of `vscode` imports — `src/registry/**` is shared by the
 * CLI and the extension, and keeping this pure is what lets
 * `test/registry/session-status.test.mjs` assert the recovery routing
 * without an extension host.
 */

/**
 * Which recovery the pane offers.
 *
 * `sign-in` is the DEFAULT and is what every environment with a CIMD
 * identity gets — re-running OAuth is the one-click route. `update-token` is
 * for a **token-only** environment (sandbox has no `clientId`, by design and
 * with no plans to change): there is no OAuth flow to re-run there, so the
 * only honest recovery is the access-token control, which after this round
 * lives in Settings › Advanced (never in this pane — see `identity-view.ts`).
 */
export type SessionRecovery = 'sign-in' | 'update-token';

export interface ExpiredSessionNotice {
  /** The pane's headline while the credential is dead. */
  readonly headline: string;
  /** The inline message, PO shape: "Session expired — Sign in again". */
  readonly message: string;
  /** The one-click action's button label. */
  readonly actionLabel: string;
  readonly action: SessionRecovery;
  /** Why the action is the one offered — one sentence, no jargon. */
  readonly detail: string;
  /** The status-bar hover hint (the status bar itself only gains a warning glyph). */
  readonly statusBarTooltip: string;
}

/**
 * True only for a credential we can PROVE is dead.
 *
 * `undefined` (an opaque token, or a JWT with no `exp`) is NOT expired: the
 * paste and mint flows accept both, and the same rule governs the credential
 * gate in `token-provider.ts`. Guessing "expired" here would tell the user
 * to sign in again while their token still works.
 */
export function isSessionExpired(expiry: Date | undefined, now: Date = new Date()): boolean {
  return expiry !== undefined && expiry.getTime() <= now.getTime();
}

/** True when `env` has a CIMD identity, i.e. an OAuth sign-in exists to re-run. */
export function hasOAuthSignIn(env: string): boolean {
  return ENVIRONMENTS[env]?.clientId !== undefined;
}

/** The inline expired-session prompt for `env`, routed by whether that environment has an OAuth sign-in at all. */
export function expiredSessionNotice(env: string): ExpiredSessionNotice {
  const label = environmentLabel(env);

  if (hasOAuthSignIn(env)) {
    return {
      headline: 'Session expired',
      message: 'Session expired — Sign in again',
      actionLabel: 'Sign in again',
      action: 'sign-in',
      detail: `Your ${label} credential has expired. Signing in again issues a fresh session.`,
      statusBarTooltip: `FortMesa Saferoom — ${label} session expired; sign in again from the Signed-in user view`,
    };
  }

  return {
    headline: 'Session expired',
    message: 'Session expired — replace the access token',
    actionLabel: 'Open Settings › Advanced',
    action: 'update-token',
    detail:
      `${label} is token-only — it has no sign-in flow, so an expired access token has to be replaced. ` +
      'Settings › Advanced holds the access-token control.',
    statusBarTooltip: `FortMesa Saferoom — ${label} access token expired; replace it in Settings › Advanced`,
  };
}
