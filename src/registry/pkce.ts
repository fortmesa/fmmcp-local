import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) primitives — shared by the
 * CLI's `login` subcommand (`src/local-mcp/cli.ts`) and the Saferoom VSIX's
 * `fortmesa.login` command (`src/extension/login-command.ts`), per
 * VSIX-PLAN.md §4.3 as amended 2026-07-05 (remote browser-callback OAuth is
 * post-prototype; loopback-callback + paste-code are the two supported
 * paths — see `oauth-flow.ts` for the transport-level mechanics of each).
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by both
 * the CLI and extension artifacts (GEMINI.md / VSIX-PLAN.md §3.1).
 */

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/**
 * BASE64URL(SHA256(ASCII(verifier))) — RFC 7636 §4.2's "S256" transform,
 * exported standalone (rather than inlined into `generatePkcePair`) so it
 * can be exercised in a unit test against RFC 7636 Appendix B.1's own
 * worked example, independent of `generatePkcePair`'s internal
 * `randomBytes` call.
 */
export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Generate a fresh PKCE verifier/challenge pair.
 *
 * `verifier`: 32 random bytes, base64url-encoded (RFC 7636 §4.1) — 43
 * characters, comfortably within the mandated 43-128 char range, and
 * already restricted to the spec's unreserved-character alphabet (base64url
 * never emits '+', '/', or '=' padding).
 *
 * `challenge`: `deriveChallenge(verifier)` — always method "S256". This
 * codebase never sends the "plain" method, matching the fmweb-be verifier
 * (`oidcAuth.service.ts`'s `pkceVerify`, curriculum 03), which is the only
 * method worth supporting for a public client with no client_secret.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: deriveChallenge(verifier), method: 'S256' };
}

export interface AuthorizeUrlParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  /**
   * RFC 8707 resource indicator — REQUIRED for the CIMD/Auth0 flow: without
   * it Auth0 resolves no API audience, falls back to its userinfo audience,
   * and rejects the request outright for third-party clients ("The userinfo
   * audience is not allowed for third party clients"). Optional here only so
   * the legacy fmweb-be appstore flow can still omit it.
   */
  readonly resource?: string;
  /** Space-separated scopes (e.g. `openid profile email offline_access`). */
  readonly scope?: string;
  /**
   * `prompt=login` forces Auth0 to re-authenticate even when a tenant SSO
   * session exists — the "Use a different account" affordance. Without it, a
   * user who is already signed in as someone else is silently handed that
   * same identity back, which is the entire bug the affordance exists to fix.
   */
  readonly prompt?: 'login';
  /**
   * `login_hint` pre-fills the identifier on the Auth0 login page — the
   * "Continue as <email>" affordance. It is an email address travelling over
   * https in a URL the user themselves opens; it is not a secret, but it is
   * PII, so it is only ever sent when the user picked that button.
   */
  readonly loginHint?: string;
}

/**
 * Build the `<authorizeBase>/authorize` URL. `authorizeBase` is whichever
 * authorization server the caller resolved: the Auth0 issuer for the CIMD
 * login (`oauth-provider.ts` — the current flow), or an fmweb-be apiBase for
 * the legacy appstore flow (fmweb-be's server-level rewrite maps the public
 * `/authorize` path onto `/api/iv2/oidcAuth/authorize`, so both shapes are
 * identical from here). Always `response_type=code` +
 * `code_challenge_method=S256` — the only combination this codebase
 * generates. Encoding is entirely delegated to `URL`/`URLSearchParams` —
 * never manual string concatenation — so every param is correctly escaped.
 */
export function buildAuthorizeUrl(authorizeBase: string, params: AuthorizeUrlParams): string {
  const url = new URL(`${authorizeBase.replace(/\/+$/, '')}/authorize`);
  const search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  if (params.resource !== undefined) search.set('resource', params.resource);
  if (params.scope !== undefined) search.set('scope', params.scope);
  if (params.prompt !== undefined) search.set('prompt', params.prompt);
  if (params.loginHint !== undefined && params.loginHint !== '') search.set('login_hint', params.loginHint);
  url.search = search.toString();
  return url.toString();
}

export interface ExchangeCodeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  /** RFC 8707 resource indicator — must be repeated on the token request. */
  readonly resource?: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  /**
   * Present when `offline_access` was granted. The tenant runs refresh-token
   * ROTATION: every refresh invalidates this value and returns a replacement,
   * so callers must persist the newest one after every grant.
   */
  readonly refresh_token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `POST <apiBase>/oauth/token` (VSIX-PLAN.md §4.3 / §8, curriculum 03) —
 * exchange an authorization code for an access token via PKCE, with NO
 * `client_secret` (this is a secret-less public client — a VS Code
 * extension / CLI cannot keep a secret). Sends a JSON body: fmweb-be's
 * `oAuthToken` handler (`fmweb-be src/controllers/iv2/oidc-auth.controller.ts`,
 * read-only reference — not modified here) declares its `@requestBody` as
 * accepting BOTH `application/json` and `application/x-www-form-urlencoded`
 * for this endpoint, so JSON is used for simplicity.
 *
 * Throws a plain `Error` with the response status and body text on any
 * non-2xx response, and on a 2xx response that doesn't actually carry
 * `access_token`/`expires_in`. Never logs the code, verifier, or any token.
 *
 * KNOWN GAP (curriculum 03 / VSIX-PLAN.md §8, not a bug in this function):
 * until (1) an `appstoreAuth` record for `client_id: "fortmesa-saferoom"`
 * is created (ops, not yet done) and (2) fmweb-be's
 * `oidcAuth.service.ts:170` `client_secret && code_verifier` check is
 * fixed to `||` semantics, this call will fail server-side for a
 * secret-less PKCE client even given a perfectly valid request. That is
 * expected and out of scope for this change (see the task's scope
 * boundary) — this function is written to work correctly once both land.
 */
export async function exchangeCodeForToken(tokenBase: string, params: ExchangeCodeParams): Promise<TokenResponse> {
  return postTokenRequest(tokenBase, {
    grant_type: 'authorization_code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
    ...(params.resource !== undefined ? { resource: params.resource } : {}),
  });
}

export interface RefreshTokenParams {
  readonly clientId: string;
  readonly refreshToken: string;
  /** RFC 8707 resource indicator — keeps the refreshed token on the same audience. */
  readonly resource?: string;
}

/**
 * `POST <tokenBase>/oauth/token` with `grant_type=refresh_token`. The tenant
 * rotates refresh tokens, so the response's `refresh_token` (when present)
 * REPLACES the one passed in — the caller must persist it immediately; the
 * old value is dead either way.
 */
export async function refreshAccessToken(tokenBase: string, params: RefreshTokenParams): Promise<TokenResponse> {
  return postTokenRequest(tokenBase, {
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
    ...(params.resource !== undefined ? { resource: params.resource } : {}),
  });
}

/**
 * Shared `POST <tokenBase>/oauth/token` mechanics for both grant types.
 * Sent form-encoded — required by Auth0's token endpoint and equally
 * accepted by fmweb-be's `oAuthToken` handler (its `@requestBody` declares
 * both JSON and `application/x-www-form-urlencoded`). Throws a plain `Error`
 * on any non-2xx, non-JSON, or shape-invalid response. Never logs codes,
 * verifiers, or tokens.
 */
async function postTokenRequest(tokenBase: string, form: Record<string, string>): Promise<TokenResponse> {
  const url = `${tokenBase.replace(/\/+$/, '')}/oauth/token`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new Error(
      `could not reach ${url} for the token request (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '(could not read response body)');
    throw new Error(
      `token request failed: POST ${url} -> HTTP ${String(response.status)} ${response.statusText}: ${bodyText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `token response from ${url} was not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  if (!isRecord(body) || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error(`token response from ${url} was missing "access_token"/"expires_in": ${JSON.stringify(body)}`);
  }

  return {
    access_token: body.access_token,
    expires_in: body.expires_in,
    ...(typeof body.refresh_token === 'string' && body.refresh_token !== ''
      ? { refresh_token: body.refresh_token }
      : {}),
  };
}
