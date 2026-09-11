/**
 * CIMD OAuth provider resolution — which authorization server, client
 * identity, and resource indicator the login flow uses.
 *
 * Saferoom signs in against the shared Auth0 tenant using a Client ID
 * Metadata Document (CIMD): the `client_id` IS an https URL hosting the
 * client's metadata JSON.
 *
 * EVERY ENVIRONMENT HAS ITS OWN CLIENT IDENTITY AND ITS OWN LOGIN. They are
 * not interchangeable, and there is no fallback between them: a next session
 * must never reach prod, and a prod session must never reach next. Auth0
 * enforces the same boundary — a client is authorized against specific
 * resource servers, so presenting one environment's client_id while
 * requesting another's API is rejected at authorize with
 * "Client ... is not authorized to access resource server ...".
 *
 * The `resource` indicator still selects the API audience within an
 * environment; it is not a substitute for the per-environment identity.
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by both
 * the CLI and extension artifacts (GEMINI.md / VSIX-PLAN.md §3.1).
 */

import { ENVIRONMENTS } from './environments.js';

/** The shared Auth0 tenant. All environments authorize against this issuer. */
const DEFAULT_ISSUER = 'https://auth.fortmesa.com';

/**
 * Scopes requested at authorize time. `openid profile email` drive the
 * `fm/*` custom claims fmweb-be's auth path consumes (first-contact
 * enrollment binds by email); `offline_access` requests a refresh token
 * (rotation is ON tenant-side — every refresh returns a replacement).
 */
export const OAUTH_SCOPE = 'openid profile email offline_access';

export interface OAuthProvider {
  /** Issuer base with NO trailing slash — `<issuerBase>/authorize`, `<issuerBase>/oauth/token`. */
  readonly issuerBase: string;
  /** The CIMD document URL used verbatim as `client_id`. */
  readonly clientId: string;
  /** RFC 8707 resource indicator — the target API's identifier (its origin). */
  readonly resource: string;
  /** Space-separated scope string sent on the authorize request. */
  readonly scope: string;
}

/**
 * Resolve the OAuth provider for a sign-in to environment `env`.
 *
 * - `FMCODE_OAUTH_ISSUER` overrides the issuer (a self-hosted/test AS).
 * - `client_id` is `env`'s own CIMD document URL from `environments.ts`.
 *   REQUIRED: an environment lacking one cannot sign in at all, and this
 *   throws rather than borrowing another environment's identity.
 *   `FMCODE_OAUTH_CLIENT_ID` overrides it for one-off testing only.
 * - `resource` is `env`'s own `api` origin from `environments.ts` — the SAME
 *   single source of truth the client_id comes from. The Auth0 API identifiers
 *   are registered as bare origins (`https://api-next.dev.fort.blue`), and a
 *   token's `aud` must match one byte-for-byte or fmweb-be rejects it.
 *
 * `apiBase` is only a FALLBACK, for an environment the registry has never
 * heard of (a self-hosted stack the user typed a base for). It must not
 * decide the audience of a KNOWN environment, and this is the bug fixed on
 * 2026-09-08: the audience used to come from the caller's `apiBase`, which is
 * the user's stored/typed `fortmesa_api_base`, while the client_id came from
 * the registry. A production user whose stored base was the vanity brand alias
 * `https://api.vciso.app` (same servers as `api.fortmesa.com`, but not a
 * registered Auth0 resource server) got `resource=https://api.vciso.app` on
 * the authorize URL and Auth0's generic error page —
 * `access_denied : Service not found: https://api.vciso.app`, HTTP 403,
 * verified against the live tenant. Vanity/brand domains are an FE concern;
 * MCP sign-in always names the canonical API identifier (PO, 2026-09-08).
 *
 * Throws when no origin can be derived at all — with no resource indicator
 * Auth0 falls back to the userinfo audience, which is rejected for
 * third-party (CIMD) clients.
 */
export function resolveOAuthProvider(env: string, apiBase: string): OAuthProvider {
  const issuerRaw = process.env.FMCODE_OAUTH_ISSUER ?? DEFAULT_ISSUER;
  const entry = ENVIRONMENTS[env];

  // Per-environment client identity, with NO cross-environment fallback.
  // Auth0 authorizes a client against specific resource servers, so borrowing
  // another environment's client_id fails at authorize with "Client ... is not
  // authorized to access resource server ...". An environment with no identity
  // has no OAuth login at all (sandbox) and must fail here with a message that
  // says so, rather than sending the user into that error.
  const clientId = process.env.FMCODE_OAUTH_CLIENT_ID ?? entry?.clientId;
  if (clientId === undefined || clientId === '') {
    // "Mint Fresh Token" was removed in ca49425 (PO 2026-09-03), so naming it
    // here sent the user to a command that no longer exists — the last live
    // mint dead-end, and the one an EXPIRED token on a token-only environment
    // (sandbox) walks straight into, since there is no sign-in to fall back on.
    throw new Error(
      `this environment ("${env}") has no OAuth sign-in — it is token-only. ` +
        'Get an access token from the FortMesa web UI (Settings → API tokens) and install it with ' +
        '`fmmcp-local token set <env> <token>`, or in Saferoom open the "Signed-in user" view and use ' +
        'the advanced token control. Environments that DO support sign-in accept `fmmcp-local login`.',
    );
  }

  // Registry first, caller's base only for an environment we do not ship.
  const audienceSource = entry?.api ?? apiBase;
  let resource: string;
  try {
    resource = new URL(audienceSource).origin;
  } catch {
    throw new Error(
      `cannot derive an OAuth resource indicator for environment "${env}" from API base "${audienceSource}" — not a valid URL`,
    );
  }

  return {
    issuerBase: issuerRaw.replace(/\/+$/, ''),
    clientId,
    resource,
    scope: OAUTH_SCOPE,
  };
}
