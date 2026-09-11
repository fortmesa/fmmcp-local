/**
 * What a data region's stored credential IS, and whether saving one should
 * make that region the active one.
 *
 * ## The defect this exists for
 *
 * PO, 2026-09-09: *"Custom environment (eg next) for testing … didn't
 * actually add a selectable identity after adding it."* Saving an access
 * token for `next` writes `credentials.json`'s `next` block and nothing
 * else. `activeEnv` lives in a DIFFERENT file (`config.json`) and stayed
 * `prod`, so every surface — the Signed-in user view, the scope selector,
 * the Tools list, the status bar — went on reading `prod`, which had no
 * credential. The saved token was real, on disk, and invisible: the panel
 * said *"Access token saved for Functional Testing (Next)"* one line above
 * *"Not signed in · Production (NA-US)"*.
 *
 * The switch itself already worked (the Data region control writes
 * `config.json`, which IS watched, and `extension.ts`'s `applyConfig` repaints
 * everything from it). What was missing was any connection between "I just
 * supplied a credential for X" and "X is what I want to use", and any visible
 * per-region statement of which regions hold a credential at all.
 *
 * ## The two decisions, kept pure and here
 *
 * Both are pure functions of already-read state so `test/registry/region-identity.test.mjs`
 * can assert them without an extension host, and so the adoption rule cannot
 * drift between the settings panel and any future caller. `vscode`-free like
 * the rest of `registry/` (VSIX-PLAN.md §3.1).
 */

import { credentialKind, type CredentialKind } from './credential-kind.js';
import { readCredentialsSummary, readRefreshToken } from './credentials.js';
import { hasOAuthSignIn } from './session-status.js';

/**
 * A region's credential state, as the Data region list chips it.
 *
 * `expired` is a state of its own rather than being folded into `signed-in`.
 * The brief for this round named three chips; a fourth is here deliberately,
 * because `registry/session-status.ts` exists precisely because an expired
 * credential rendering as "Signed in" is the bug that got reported before
 * (PO, 2026-09-05). A chip that says "Signed in" over a dead token would
 * re-create it, and folding expiry into "Not signed in" would hide that
 * re-signing-in is the fix rather than pasting a first token.
 */
export type RegionCredentialState = 'signed-in' | 'token-saved' | 'expired' | 'none';

export interface RegionCredentialInputs {
  /** A non-empty `fortmesa_api_token` is stored for this region. */
  readonly hasToken: boolean;
  /** Provably past its `exp`. `undefined`/false means "not provably dead" — an opaque token is NOT expired (`session-status.ts`'s `isSessionExpired` rule). */
  readonly expired?: boolean;
  /** The credential kind, from `credential-kind.ts`. Only consulted when a live token exists. */
  readonly kind?: CredentialKind;
}

/** Classify one region's stored credential. */
export function regionCredentialState(inputs: RegionCredentialInputs): RegionCredentialState {
  if (!inputs.hasToken) return 'none';
  if (inputs.expired === true) return 'expired';
  return inputs.kind === 'sign-in' ? 'signed-in' : 'token-saved';
}

/** The chip word for a region state. The list renders these verbatim and never invents a state name (same rule as `registry/agent-status.ts`). */
export function regionChipLabel(state: RegionCredentialState): string {
  switch (state) {
    case 'signed-in':
      return 'Signed in';
    case 'token-saved':
      return 'Token saved';
    case 'expired':
      return 'Session expired';
    case 'none':
      return 'Not signed in';
  }
}

/**
 * True when this region holds a credential Saferoom could actually use right
 * now. An expired one does not count: `local-mcp/auth/token-provider.ts`
 * refuses it and every tool call dies, so treating it as "occupied" would
 * strand the user on a dead region.
 */
export function hasUsableCredential(state: RegionCredentialState): boolean {
  return state === 'signed-in' || state === 'token-saved';
}

export interface AdoptRegionInputs {
  /** The region a credential was just saved for. */
  readonly savedEnv: string;
  /** The region currently active (`config.json`'s `activeEnv`). */
  readonly activeEnv: string;
  /** The active region's credential state, read BEFORE the save. */
  readonly activeState: RegionCredentialState;
}

/**
 * Whether saving a credential for `savedEnv` should switch the active region
 * to it.
 *
 * The rule is deliberately narrow — it fires only when the switch cannot
 * take anything away:
 *
 *  - Same region: nothing to do.
 *  - The active region has a usable credential: **do not switch.** A user
 *    signed in to production who seeds a `next` token has not asked to leave
 *    production, and silently moving them would point every tool call at a
 *    different tenant's data. The caller shows a "Switch to X" affordance
 *    instead ({@link switchOfferNotice}).
 *  - The active region has nothing usable (no token, or a provably expired
 *    one): switch. There is no session to lose, and staying put is what
 *    produced the reported symptom.
 */
export function shouldAdoptSavedRegion(inputs: AdoptRegionInputs): boolean {
  if (inputs.savedEnv === inputs.activeEnv) return false;
  return !hasUsableCredential(inputs.activeState);
}

/** The one-line note shown after an automatic switch. Names the region, because the user did not ask for the switch and has to be able to see that it happened. */
export function adoptedRegionNotice(regionLabel: string): string {
  return `Switched to ${regionLabel}.`;
}

/** The offer shown instead when the active region still holds a usable credential — the switch is one click, but it is the user's click. */
export function switchOfferNotice(savedRegionLabel: string, activeRegionLabel: string): string {
  return `Still using ${activeRegionLabel}. Switch to ${savedRegionLabel}?`;
}

/**
 * Read one region's credential state off disk.
 *
 * The one composer for the three facts the classification needs (is there a
 * token, is it provably dead, is there a refresh token beside it) so the
 * settings panel's chips and the adoption decision can never disagree about
 * what a region's state is. Propagates a read failure rather than
 * swallowing it: a caller deciding whether to MOVE the user must be able to
 * tell "no credential" apart from "could not tell", and the two want
 * opposite behaviour.
 */
export async function readRegionCredentialState(env: string): Promise<RegionCredentialState> {
  const summary = await readCredentialsSummary(env);
  if (!summary.hasToken) return 'none';
  if (summary.expired === true) return 'expired';
  const hasRefreshToken = (await readRefreshToken(env)) !== undefined;
  return regionCredentialState({
    hasToken: true,
    expired: false,
    kind: credentialKind({ hasRefreshToken, envHasOAuthSignIn: hasOAuthSignIn(env) }),
  });
}
