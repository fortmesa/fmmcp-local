/**
 * What KIND of credential is stored for an environment — and therefore
 * whether the button that clears it says "Sign out" or "Remove".
 *
 * PO, 2026-09-08: *"for a pasted access token … it might be more appropriate
 * to label the button/link 'Remove' rather than Sign-out because the M2M will
 * still exist (presuming this does not already functionally disable the token
 * via the iv2 endpoint, and I'm not asking it to)."* Nothing here calls any
 * revocation endpoint. Both actions do exactly one thing: clear the token (and
 * any refresh token) from this machine's `credentials.json`.
 *
 * There is no stored `kind` field, so this is an inference — and the
 * asymmetry in it is deliberate. Calling a pasted machine-to-machine token's
 * removal "Sign out" over-promises a revocation that never happens; calling
 * an interactive session's end "Remove" is merely blunt. So when the evidence
 * is not positive, we under-promise.
 *
 * Rejected alternative: stamp the kind at write time in `credentials.ts`'s
 * `writeToken`. Strictly more accurate — it would catch an OAuth grant whose
 * tenant declined `offline_access` and therefore stored no refresh token —
 * but `writeToken` is the shared writer behind six call sites across the
 * sign-in session, the login flow, the token refresher and the CLI. Widening
 * its signature for a label is a blast radius the label does not justify.
 *
 * `vscode`-free (VSIX-PLAN.md §3.1) so it is unit-testable.
 */

export type CredentialKind = 'sign-in' | 'access-token';

export interface CredentialKindInputs {
  /** A refresh token is stored for this environment. Only the OAuth grant ever writes one (`credentials.ts`'s `writeToken`). */
  readonly hasRefreshToken: boolean;
  /** This environment has a CIMD client, i.e. an OAuth sign-in exists at all (`session-status.ts`'s `hasOAuthSignIn`). */
  readonly envHasOAuthSignIn: boolean;
}

/** Decide the credential kind. See the module comment for why absence of evidence resolves to `access-token`. */
export function credentialKind(inputs: CredentialKindInputs): CredentialKind {
  if (!inputs.envHasOAuthSignIn) return 'access-token';
  return inputs.hasRefreshToken ? 'sign-in' : 'access-token';
}

export interface ClearCredentialAction {
  readonly label: string;
  readonly tooltip: string;
}

/**
 * The label and tooltip for the action that clears the stored credential.
 *
 * PO also ruled out the confirmation entirely: *"this one doesn't even need
 * confirmation. Just sign out when clicking sign out even if this means
 * destroying an M2M token."* So this string pair is the ONLY warning the user
 * gets, which is why the token case says plainly that the token itself
 * survives.
 */
export function clearCredentialAction(kind: CredentialKind, regionLabel: string): ClearCredentialAction {
  return kind === 'sign-in'
    ? { label: 'Sign out', tooltip: `Signs out of ${regionLabel} in this editor.` }
    : {
        label: 'Remove',
        tooltip: 'Removes the stored token from this editor; the token itself stays valid',
      };
}
