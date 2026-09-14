import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { FortMesaEnvCredentials } from '../../shared/types.js';
import { DEFAULT_API_BASE, ENVIRONMENTS } from '../../registry/environments.js';
import { decodeJwtExpiry } from '../../registry/credentials.js';
import { refreshIfExpiring, type RefreshOutcome } from '../../registry/token-refresh.js';
import { hasOAuthSignIn } from '../../registry/session-status.js';

/**
 * Credential chain (AWS CLI model, SECURITY.md §2.2), v1 subset:
 *   1. Environment variables: FORTMESA_API_TOKEN (+ FORTMESA_API_BASE)
 *   2. Shared credentials file: ~/.fmcode/credentials.json (multi-env)
 * Deferred (TODOS): VS Code SecretStorage (VSIX phase), SSO cache, interactive prompt.
 */

const envCredentialsSchema = z.object({
  fortmesa_api_token: z.string().min(1),
  fortmesa_api_base: z.string().min(1),
  generated_at: z.string().min(1),
  expires_at: z.string().min(1),
  scopeMap: z.record(z.string(), z.string()).optional(),
});

const credentialsFileSchema = z.object({
  environments: z.record(z.string(), envCredentialsSchema),
});

/**
 * How early a token counts as expired.
 *
 * A token with two seconds left passes a naive `exp > now` check and then
 * 401s mid-request, which surfaces as a confusing gateway error rather than
 * "sign in again". The margin also absorbs clock drift between this machine
 * and the issuer.
 */
const EXPIRY_SKEW_MS = 30_000;

export interface ResolveOptions {
  /**
   * Notified after every refresh attempt, including the ones that did nothing.
   * Callers with a logger use it to surface renewals; the outcome never
   * carries a token value.
   */
  readonly onRefresh?: (outcome: RefreshOutcome) => void;

  /**
   * Return the entry even when its token has already expired.
   *
   * Only for callers that read `baseUrl` and never touch `token`. The login
   * flows use it: the whole point of signing in again is that the stored
   * token is dead, and the API base recorded next to it is still the right
   * one to authenticate against.
   */
  readonly allowExpired?: boolean;
}

export interface ResolvedCredentials {
  readonly token: string;
  readonly baseUrl: string;
  readonly source: 'env' | 'credentials-file';
  readonly scopeMap?: Record<string, string>;
  readonly expiresAt?: string;
}

/**
 * Resolve credentials for the given environment name.
 *
 * Env vars win: FORTMESA_API_TOKEN with FORTMESA_API_BASE (base falls back to
 * the credentials file's entry for `env`, then to DEFAULT_API_BASE).
 *
 * A token close to expiry is refreshed first, when a refresh token is stored
 * for the environment. Throws only when what remains has expired, so an
 * expired token is never handed to a caller that would put it on the wire.
 * Pass `{ allowExpired: true }` only when reading `baseUrl` alone; that path
 * skips both the refresh and the check.
 */
export async function resolveCredentials(env: string, options: ResolveOptions = {}): Promise<ResolvedCredentials> {
  const envToken = process.env.FORTMESA_API_TOKEN;
  const envBase = process.env.FORTMESA_API_BASE;

  const fileCreds = await loadCredentialsFile(env).catch(() => undefined);

  if (envToken !== undefined && envToken !== '') {
    // Order matters, and the middle term was missing. With FORTMESA_API_TOKEN
    // set and no credentials.json (an MCPB install, or any fresh machine),
    // this fell straight through to DEFAULT_API_BASE and pointed a `--env
    // prod` run at sandbox's base URL. The selected environment already knows
    // its own API base; use it before the global default.
    const baseUrl =
      envBase !== undefined && envBase !== ''
        ? envBase
        : (fileCreds?.fortmesa_api_base ?? ENVIRONMENTS[env]?.api ?? DEFAULT_API_BASE);
    if (options.allowExpired !== true) assertNotExpired(envToken, env, 'FORTMESA_API_TOKEN');
    const resolved: ResolvedCredentials = { token: envToken, baseUrl, source: 'env' };
    return fileCreds?.scopeMap !== undefined ? { ...resolved, scopeMap: fileCreds.scopeMap } : resolved;
  }

  if (fileCreds === undefined) {
    throw new Error(
      `No credentials available for env "${env}". Set FORTMESA_API_TOKEN or add the environment ` +
        `to ~/.fmcode/credentials.json (see README).`,
    );
  }

  let token = fileCreds.fortmesa_api_token;

  if (options.allowExpired !== true) {
    // Try to renew BEFORE judging the token. Reaching assertNotExpired with a
    // usable refresh token sitting on disk would fail a session that did not
    // need to end.
    const outcome = await refreshIfExpiring(env, token, fileCreds.fortmesa_api_base);
    if (outcome.token !== undefined) token = outcome.token;
    options.onRefresh?.(outcome);

    assertNotExpired(token, env, 'credentials.json');
  }

  const resolved: ResolvedCredentials = {
    token,
    baseUrl: fileCreds.fortmesa_api_base,
    source: 'credentials-file',
    expiresAt: fileCreds.expires_at,
  };
  return fileCreds.scopeMap !== undefined ? { ...resolved, scopeMap: fileCreds.scopeMap } : resolved;
}

/** Resolve the fmcode directory. `FMCODE_DIR` overrides `~/.fmcode` for tests (mirrors registry/config.ts, registry/scope-resolve.ts, registry/credentials.ts). */
function credentialsDir(): string {
  return process.env.FMCODE_DIR ?? join(homedir(), '.fmcode');
}

async function loadCredentialsFile(env: string): Promise<FortMesaEnvCredentials> {
  const credPath = join(credentialsDir(), 'credentials.json');
  const raw = await readFile(credPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  const result = credentialsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid credentials file at ${credPath}: ${issues}`);
  }

  const envBlock = result.data.environments[env];
  if (envBlock === undefined) {
    const available = Object.keys(result.data.environments).join(', ');
    throw new Error(`Environment "${env}" not found in ${credPath}. Available: ${available}`);
  }
  return envBlock as FortMesaEnvCredentials;
}

/**
 * Throw if `token` is a JWT whose `exp` has passed (or falls inside
 * {@link EXPIRY_SKEW_MS}).
 *
 * Rejects only what it can PROVE is expired. `decodeJwtExpiry` returns
 * undefined for an opaque API token or a JWT with no `exp` claim, and those
 * pass through untouched: this must not break the non-JWT tokens the paste
 * and mint flows accept.
 *
 * `source` names where the token came from so the message points at the
 * thing the user has to fix. The token itself never appears in it.
 *
 * The recovery line is routed the same way `registry/session-status.ts`
 * routes the Signed-in user pane: `sandbox` has no `clientId` (token-only,
 * by design), so telling it to run `fmmcp-local login sandbox` is a dead
 * end — that command needs an OAuth-capable environment. Environments with
 * a `clientId` get the sign-in line; token-only environments get the
 * token-replacement line instead.
 */
function assertNotExpired(token: string, env: string, source: string): void {
  const expiry = decodeJwtExpiry(token);
  if (expiry === undefined) return;

  const remainingMs = expiry.getTime() - Date.now();
  if (remainingMs > EXPIRY_SKEW_MS) return;

  // Two different situations, and saying "expired at" about a future
  // timestamp reads as a bug to whoever hits it.
  const when =
    remainingMs <= 0
      ? `expired at ${expiry.toISOString()}`
      : `expires at ${expiry.toISOString()}, inside the ${String(EXPIRY_SKEW_MS / 1000)}s safety margin`;

  const recovery = hasOAuthSignIn(env)
    ? `Your session has expired. Run \`fmmcp-local login ${env}\` (or use Sign In in the FortMesa sidebar).`
    : `Your ${env} access token has expired. Paste a new one in Settings › Identity › Advanced, or run \`fmmcp-local token set ${env}\`.`;

  throw new ExpiredCredentialError(`The token for env "${env}" (${source}) ${when}. ${recovery}`);
}

/**
 * The failure `assertNotExpired` throws.
 *
 * A distinct type rather than a plain `Error`, because callers need to tell
 * "your session ran out" apart from "there are no credentials at all" and
 * from "the credentials file is malformed" — and the only other way to do
 * that is to pattern-match the message, which is user-facing prose that gets
 * reworded. The Event viewer's `auth.expired` row depends on this
 * distinction (`local-mcp/auth-events.ts`); so would any future
 * re-authentication prompt.
 */
export class ExpiredCredentialError extends Error {
  override readonly name = 'ExpiredCredentialError';
}

/** True when `error` is the credential chain's "this token has expired" refusal. */
export function isExpiredCredentialError(error: unknown): error is ExpiredCredentialError {
  return error instanceof ExpiredCredentialError;
}
