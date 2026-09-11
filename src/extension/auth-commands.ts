import { environmentLabel, requireSecureApiBase } from '../registry/environments.js';
import type { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { connectGateway } from '../local-mcp/proxy.js';
import { loadConfig, saveConfig } from '../registry/config.js';
import { clearToken, decodeJwtExpiry, writeToken } from '../registry/credentials.js';
import { errorMessage } from '../shared/errors.js';
import { notifyIdentityChanged } from '../registry/identity-events.js';
import {
  adoptedRegionNotice,
  readRegionCredentialState,
  shouldAdoptSavedRegion,
  switchOfferNotice,
  type RegionCredentialState,
} from '../registry/region-identity.js';

/**
 * The auth ACTIONS behind the Signed-in user view (`identity-view.ts`):
 * validating + saving a pasted access token, and signing out.
 *
 * 2026-09-03 (PO) — this module no longer registers any command:
 *
 *  - **Token minting is gone entirely.** `fortmesa.mintToken` / "Mint Fresh
 *    Token" and `registry/credentials.ts`'s `mintTokenViaApi` were deleted.
 *    Mint only ever ROTATED an existing machine-to-machine token
 *    (`POST /api/iv2/createNewJwtToken`) — it could not create one from
 *    nothing — so all it bought was skipping a trip to the web UI on the
 *    discouraged path. A leftover palette entry IS the low-resistance path,
 *    so the command and its manifest entry went with the function.
 *  - **`fortmesa.pasteToken` is gone as a command.** Pasting a token is an
 *    ADVANCED control that lives INLINE inside the Signed-in user view, not
 *    a command-palette prompt (PO: "inline expansion for advanced in
 *    identity and inline bearer submission not a command palette thing").
 *    The environment quickpick that used to stand in front of it survives
 *    as a `<select>` inside that inline control — it is the only way to seed
 *    credentials for a NON-active environment.
 *  - **`fortmesa.signOut` is gone as a command, and its modal with it.** A
 *    modal is wrong for an MDI app (PO: "the dialogue may not even be on the
 *    same monitor or lost underneath windows"); sign-out is confirmed inline,
 *    in the pane where the user clicked.
 *
 * Signing in (`fortmesa.login`) is the default route and keeps its command.
 *
 * Everything here stays a plain async function returning a result object —
 * no toasts, no quickpicks — so the webview view owns all presentation. It
 * also imports NO `vscode`, deliberately: that is what lets
 * `test/registry/auth-actions.test.mjs` load this module in a plain Node
 * test and assert the fail-closed rule (a token the gateway rejects is
 * never written to disk) without an extension host.
 */

/** Extract the first text-content string from a tool result (mirrors proxy.ts's filterScopesResult / scope-resolve.ts's extractResultText — each `vscode`-adjacent module keeps its own tiny copy rather than reaching across the registry/extension boundary for it). */
function extractResultText(result: CallToolResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  return first.text;
}

/**
 * Probe `token` against `gatewayUrl` with a cheap `grc_scopes list` call —
 * the live-gateway half of paste-token validation (curriculum 03 "Rules for
 * your implementation"). Resolves on success; throws a user-facing reason on
 * any failure (connect/auth failure, tool error, malformed result). Always
 * closes the short-lived client it opens.
 */
async function probeToken(gatewayUrl: URL, token: string, clientVersion: string): Promise<void> {
  const client: Client = await connectGateway(gatewayUrl, token, clientVersion);
  try {
    const result = await client.callTool({ name: 'grc_scopes', arguments: { method: 'list' } });
    const text = extractResultText(result);
    if (result.isError === true || text === undefined) {
      throw new Error('the gateway rejected a test call (grc_scopes list) with this token');
    }
  } finally {
    await client.close();
  }
}

/**
 * Outcome of {@link submitAccessToken}. `needsApiBase` asks the inline control
 * to reveal its API-base field and resubmit — never a separate prompt.
 *
 * On success exactly one of `regionNote`/`offerSwitchTo` may be present, and
 * they are the fix for the reported defect: a saved credential now either
 * becomes the active region or visibly offers to.
 */
export type SubmitTokenResult =
  | {
      readonly ok: true;
      readonly expiry: Date;
      /** Set when the active region was switched to the one just saved for. One line, shown beside the save confirmation. */
      readonly regionNote?: string;
      /** Set instead when the active region still holds a usable credential: the region to offer a one-click switch to. */
      readonly offerSwitchTo?: { readonly env: string; readonly label: string; readonly notice: string };
    }
  | { readonly ok: false; readonly message: string; readonly needsApiBase?: true };

/**
 * Validate (JWT `exp` decode + live gateway probe) and then save a pasted
 * access token for `env`. Never writes on failure — a token that cannot
 * reach the gateway is not saved, exactly as the removed command behaved.
 *
 * `apiBase` is only consulted when `env` has no credentials block yet;
 * `writeToken` throws in that case and the caller is told to collect it
 * inline (`needsApiBase`).
 */
export async function submitAccessToken(
  env: string,
  token: string,
  apiBase: string | undefined,
  clientVersion: string,
): Promise<SubmitTokenResult> {
  const trimmed = token.trim();
  if (trimmed === '') return { ok: false, message: 'Paste an access token first.' };

  let gatewayUrlStr: string | undefined;
  try {
    gatewayUrlStr = (await loadConfig()).environments[env]?.gateway;
  } catch (error) {
    return { ok: false, message: `Failed to load config.json (${errorMessage(error)}).` };
  }
  if (gatewayUrlStr === undefined) {
    return { ok: false, message: `No gateway configured for "${env}".` };
  }

  const expiry = decodeJwtExpiry(trimmed);
  if (expiry === undefined) {
    return {
      ok: false,
      message: 'That does not look like a valid access token (no readable "exp" claim) — nothing was saved.',
    };
  }

  try {
    await probeToken(new URL(gatewayUrlStr), trimmed, clientVersion);
  } catch (error) {
    return { ok: false, message: `The gateway rejected that token (${errorMessage(error)}) — nothing was saved.` };
  }

  let base = apiBase?.trim();
  if (base !== undefined && base !== '') {
    // F-6: a user-typed base is used to send the bearer; refuse cleartext.
    try {
      base = requireSecureApiBase(base);
    } catch (error) {
      return { ok: false, message: `${errorMessage(error)} Nothing was saved.` };
    }
  }
  try {
    await writeToken(env, trimmed, base === '' ? undefined : base);
  } catch (error) {
    // writeToken only throws when `env` has no existing block AND no base
    // URL was supplied — ask for it inline and let the user resubmit,
    // rather than failing an already-validated token outright.
    if (base === undefined || base === '') {
      return {
        ok: false,
        needsApiBase: true,
        message: `"${env}" has no credentials yet — enter its API base URL below, then submit again.`,
      };
    }
    return { ok: false, message: `Failed to save the token for "${env}" (${errorMessage(error)}).` };
  }

  // A pasted token is an identity change like any other, and credentials.json
  // has no watcher. No `label`: nothing here has fetched an identity, and
  // "no additional calls" rules out fetching one to decorate a notice.
  notifyIdentityChanged({ kind: 'signed-in', env });

  const region = await adoptSavedRegion(env);
  return { ok: true, expiry, ...region };
}

/**
 * Make the region a credential was just saved for reachable: adopt it as the
 * active region when the active one has nothing usable, and otherwise hand
 * back the offer for the caller to render.
 *
 * PO, 2026-09-09: saving a token for `next` "didn't actually add a selectable
 * identity". It wrote `credentials.json`; `activeEnv` lives in `config.json`
 * and stayed on `prod`, so every surface kept reading a region with no
 * credential. Writing `activeEnv` here is what closes it — and it is the
 * cheap half, because `config.json` IS watched: `extension.ts`'s `applyConfig`
 * then repaints the status bar, all three trees, the scope panel and this
 * webview with no further plumbing.
 *
 * Never throws, and never switches on incomplete information: any failure to
 * read the active region's state or to persist the switch leaves the user
 * exactly where they were, with the token still saved. Moving someone between
 * tenants is the one thing here that must not happen by accident.
 */
async function adoptSavedRegion(
  savedEnv: string,
): Promise<Pick<Extract<SubmitTokenResult, { ok: true }>, 'regionNote' | 'offerSwitchTo'>> {
  let activeEnv: string;
  let activeState: RegionCredentialState;
  try {
    activeEnv = (await loadConfig()).activeEnv;
    activeState = await readRegionCredentialState(activeEnv);
  } catch {
    return {};
  }
  if (savedEnv === activeEnv) return {};

  const savedLabel = environmentLabel(savedEnv);
  if (!shouldAdoptSavedRegion({ savedEnv, activeEnv, activeState })) {
    return {
      offerSwitchTo: {
        env: savedEnv,
        label: savedLabel,
        notice: switchOfferNotice(savedLabel, environmentLabel(activeEnv)),
      },
    };
  }

  try {
    const config = await loadConfig();
    await saveConfig({ ...config, activeEnv: savedEnv });
  } catch {
    return {
      offerSwitchTo: {
        env: savedEnv,
        label: savedLabel,
        notice: switchOfferNotice(savedLabel, environmentLabel(activeEnv)),
      },
    };
  }
  return { regionNote: adoptedRegionNotice(savedLabel) };
}

/**
 * Clear the stored access token for `env` (blanks `fortmesa_api_token`)
 * while PRESERVING `fortmesa_api_base` and any cached `scopeMap`, so a later
 * sign-in doesn't need to re-supply them. (Chosen over deleting the whole
 * env block — see `registry/credentials.ts`'s `clearToken` doc comment.)
 * Returns `false` when there was nothing stored to clear.
 */
export async function signOutOfEnvironment(env: string): Promise<boolean> {
  return clearToken(env);
}
