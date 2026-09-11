import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Shared `~/.fmcode/credentials.json` read/write helpers (VSIX-PLAN.md §3.2,
 * D-V4).
 *
 * Extracted from `src/local-mcp/cli.ts`'s `token set`
 * implementation (Phase P0) so the CLI and the Saferoom VSIX's auth commands
 * (`src/extension/auth-commands.ts`, Phase P3) share exactly one read/write
 * path for the credentials file — the drift the curriculum warns against.
 * `cli.ts` now calls into this module instead of maintaining its own copy.
 *
 * Deliberately free of `vscode` imports: `src/registry/**` is shared by both
 * the CLI and extension artifacts (see GEMINI.md / VSIX-PLAN.md §3.1). Also
 * deliberately free of `src/local-mcp/**` imports (e.g. `resolveCredentials`)
 * to keep the dependency direction one-way (local-mcp/extension depend on
 * registry, not the reverse) — `fetchIdentity` below takes the caller's
 * already-resolved base URL + token as plain arguments instead of
 * re-resolving them itself.
 *
 * Token MINTING was removed here on 2026-09-03 (PO): `mintTokenViaApi`
 * rotated an existing machine-to-machine token via
 * `POST /api/iv2/createNewJwtToken`. It could never create a token from
 * nothing, so its only value was saving a trip to the web UI on the
 * DISCOURAGED (pasted-token) path — i.e. it lowered resistance to the
 * lower-security method. Do not reintroduce it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Resolve the fmcode directory. `FMCODE_DIR` overrides `~/.fmcode` for tests (mirrors config.ts / scope-resolve.ts). */
function credentialsDir(): string {
  return process.env.FMCODE_DIR ?? join(homedir(), '.fmcode');
}

/** Absolute path to credentials.json under the (possibly overridden) fmcode dir. */
export function credentialsFilePath(): string {
  return join(credentialsDir(), 'credentials.json');
}

/** Read credentials.json as a loose JSON object; `{ environments: {} }` if the file doesn't exist yet. */
async function readCredentialsFileRaw(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return { environments: {} };
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid credentials file at ${path}: expected a JSON object`);
  }
  return parsed;
}

/** Atomic write (tmp + rename) + 0600 chmod — credentials.json holds bearer tokens. The tmp file is born 0600 (not the default umask) so there is no world-readable window before the post-rename chmod, which is kept regardless as belt-and-braces. */
async function writeCredentialsFileRaw(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}

/**
 * Best-effort decode of a JWT's payload (base64url, middle segment) into a
 * plain object. Returns `undefined` — NEVER throws — if the token isn't a
 * parseable JWT. Shared by `decodeJwtExpiry` and `decodeJwtSubject` below so
 * the base64url-unpadding logic exists in exactly one place.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1] ?? '';
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort decode of a JWT's `exp` claim into a `Date`. Returns
 * `undefined` — NEVER throws — if the token isn't a parseable JWT or lacks a
 * numeric `exp`; callers (paste-token validation in `auth-commands.ts`,
 * `writeToken` below, the Saferoom Identity panel) treat that as "expiry
 * unknown" rather than a hard failure. This is the SAME decoding logic
 * `writeToken` uses internally to populate `expires_at` — kept as a single
 * exported function rather than duplicated per curriculum 08's
 * version/logic-drift warning.
 */
export function decodeJwtExpiry(token: string): Date | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' ? new Date(exp * 1000) : undefined;
}

/**
 * Best-effort decode of a JWT's `sub` (subject) claim — the closest thing to
 * a "who is this" identifier the API (M2M) token carries (confirmed via a
 * real sandbox token: claims are `aud, exp, iat, iss, nonce, scope, sub` —
 * no `email`/`name`/`userId` claim exists). Used by the Identity panel
 * (UX-ROUND-2-PLAN.md follow-up, user feedback 2026-07-07) as a secondary,
 * hover-only identity hint — never rendered as the row's primary label,
 * since it's a raw subject value, not a friendly display name. Returns
 * `undefined` — NEVER throws — if the token isn't parseable or has no
 * string `sub`.
 */
export function decodeJwtSubject(token: string): string | undefined {
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
}

/**
 * Shared writer for `token set` (cli.ts), the OAuth sign-in flow
 * (login-command.ts) and the Signed-in user view's inline advanced
 * access-token control (identity-view.ts): creates or updates `env`'s block in credentials.json. Requires `base` when the env
 * block doesn't exist yet (there is no sensible default API base to invent).
 * When updating an existing block, every other field — notably
 * `fortmesa_api_base` and `scopeMap` — is preserved untouched; only the
 * token, `generated_at`, and `expires_at` are replaced. Never logs the token.
 */
export async function writeToken(
  env: string,
  token: string,
  base: string | undefined,
  refreshToken?: string,
): Promise<void> {
  const path = credentialsFilePath();
  const fileData = await readCredentialsFileRaw(path);

  const environments = isRecord(fileData.environments) ? fileData.environments : {};
  const existingBlock = environments[env];
  const generatedAt = new Date().toISOString();
  const expiresAt = decodeJwtExpiry(token)?.toISOString() ?? 'unknown';

  // The tenant rotates refresh tokens — a new one always replaces the stored
  // one. When the grant carried none (a plain paste-token write, or a flow
  // without offline_access), any existing stored refresh token is preserved:
  // it may still be live, and discarding it would force a full re-login.
  const refreshField =
    refreshToken !== undefined && refreshToken !== '' ? { fortmesa_refresh_token: refreshToken } : {};

  if (isRecord(existingBlock)) {
    environments[env] = {
      ...existingBlock,
      fortmesa_api_token: token,
      generated_at: generatedAt,
      expires_at: expiresAt,
      ...refreshField,
    };
  } else {
    if (base === undefined || base === '') {
      throw new Error(`Environment "${env}" not found in credentials.json — an API base URL is required to create it.`);
    }
    environments[env] = {
      fortmesa_api_token: token,
      fortmesa_api_base: base,
      generated_at: generatedAt,
      expires_at: expiresAt,
      ...refreshField,
    };
  }

  fileData.environments = environments;
  await writeCredentialsFileRaw(path, fileData);
}

/** The "Continue as <name>" display cache — the last identity that successfully signed in to an environment. Display only: it is never an authorization input, and a stale value costs the user one extra click, never access. */
export interface CachedIdentity {
  readonly email: string;
  readonly displayName: string;
}

/**
 * Remember `identity` as `env`'s last signed-in user, in that environment's
 * credentials.json block.
 *
 * Deliberately NOT a token operation: it writes only a name and an email, and
 * it preserves every other field (including the token) exactly as `writeToken`
 * does. It lives in credentials.json rather than the extension's `globalState`
 * because it is per-environment, matches the file the token itself lives in
 * (so clearing an environment's credentials clears its cached identity too),
 * and is needed by the CLI as well as the extension.
 */
export async function writeCachedIdentity(env: string, identity: CachedIdentity): Promise<void> {
  const path = credentialsFilePath();
  const fileData = await readCredentialsFileRaw(path);
  const environments = isRecord(fileData.environments) ? fileData.environments : {};
  const existingBlock = environments[env];
  if (!isRecord(existingBlock)) return; // No block means no sign-in to cache against.
  environments[env] = {
    ...existingBlock,
    fortmesa_last_identity: { email: identity.email, displayName: identity.displayName },
  };
  fileData.environments = environments;
  await writeCredentialsFileRaw(path, fileData);
}

/** Read `env`'s cached display identity — `undefined` when absent or malformed. Never throws for a bad shape: a display cache must not be able to break sign-in. */
export async function readCachedIdentity(env: string): Promise<CachedIdentity | undefined> {
  let fileData: Record<string, unknown>;
  try {
    fileData = await readCredentialsFileRaw(credentialsFilePath());
  } catch {
    return undefined;
  }
  const environments = fileData.environments;
  if (!isRecord(environments)) return undefined;
  const envBlock = environments[env];
  if (!isRecord(envBlock)) return undefined;
  const cached = envBlock.fortmesa_last_identity;
  if (!isRecord(cached)) return undefined;
  const { email, displayName } = cached;
  if (typeof email !== 'string' || email === '') return undefined;
  return { email, displayName: typeof displayName === 'string' ? displayName : '' };
}

/**
 * Read the stored refresh token for `env` — `undefined` if none. Same
 * non-destructive, never-logs contract as `readCurrentToken`.
 */
export async function readRefreshToken(env: string): Promise<string | undefined> {
  const fileData = await readCredentialsFileRaw(credentialsFilePath());
  const environments = fileData.environments;
  if (!isRecord(environments)) return undefined;

  const envBlock = environments[env];
  if (!isRecord(envBlock)) return undefined;

  const token = envBlock.fortmesa_refresh_token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Clear the stored token for `env` (blanks `fortmesa_api_token`), preserving
 * `fortmesa_api_base` / `scopeMap` / every other field on the block — the
 * Saferoom "Sign Out" semantics (see `auth-commands.ts`'s `handleSignOut`):
 * deleting the whole env block would also discard the gateway base URL and
 * any cached scopeMap, forcing a "create new environment" flow (which needs
 * a fresh `--base`/API-base prompt) on the very next sign-in.
 *
 * Returns `false` (no-op, nothing written) if `env` has no block at all —
 * there is nothing to sign out of.
 */
export async function clearToken(env: string): Promise<boolean> {
  const path = credentialsFilePath();
  const fileData = await readCredentialsFileRaw(path);

  const environments = isRecord(fileData.environments) ? fileData.environments : {};
  const existingBlock = environments[env];
  if (!isRecord(existingBlock)) {
    return false;
  }

  environments[env] = {
    ...existingBlock,
    fortmesa_api_token: '',
    // Sign-out must also drop the refresh token — leaving it would let the
    // session silently resurrect itself, which is the opposite of sign-out.
    fortmesa_refresh_token: '',
    generated_at: new Date().toISOString(),
    expires_at: 'unknown',
  };
  fileData.environments = environments;
  await writeCredentialsFileRaw(path, fileData);
  return true;
}

/**
 * Read whether credentials.json has a token for `env`, its cached expiry, and
 * whether that token has already expired. NEVER returns the token itself.
 *
 * `expired` is decoded from the stored token rather than read off the cached
 * `expires_at` string, for the same reason `readCurrentToken` exists: a
 * hand-edited file can carry an `expires_at` that no longer describes the
 * token sitting next to it. It is `undefined` when there is no token, or when
 * the token carries no `exp` claim to judge it by.
 */
export async function readCredentialsSummary(
  env: string,
): Promise<{ hasToken: boolean; expiresAt?: string; expired?: boolean }> {
  const fileData = await readCredentialsFileRaw(credentialsFilePath());
  const environments = fileData.environments;
  if (!isRecord(environments)) return { hasToken: false };

  const envBlock = environments[env];
  if (!isRecord(envBlock)) return { hasToken: false };

  const token = envBlock.fortmesa_api_token;
  const expiresAt = envBlock.expires_at;
  const hasToken = typeof token === 'string' && token.length > 0;

  const liveExpiry = hasToken ? decodeJwtExpiry(token) : undefined;
  const expired = liveExpiry === undefined ? undefined : liveExpiry.getTime() <= Date.now();

  const summary: { hasToken: boolean; expiresAt?: string; expired?: boolean } = { hasToken };
  if (typeof expiresAt === 'string') summary.expiresAt = expiresAt;
  if (expired !== undefined) summary.expired = expired;
  return summary;
}

/**
 * Read the CURRENT token stored for `env` directly from credentials.json —
 * used only by UI/validation surfaces (the Saferoom Auth tree section,
 * `auth-commands.ts`'s paste-token pre-check) that want to decode the
 * ACTUAL stored token's expiry live via `decodeJwtExpiry`, rather than
 * trusting the `expires_at` string cached at the last write (which could be
 * stale if the file was hand-edited outside of `writeToken`).
 *
 * Non-destructive; never logs the returned token. Returns `undefined` if `env`
 * has no block or no non-empty token (including right after `clearToken`).
 */
export async function readCurrentToken(env: string): Promise<string | undefined> {
  const fileData = await readCredentialsFileRaw(credentialsFilePath());
  const environments = fileData.environments;
  if (!isRecord(environments)) return undefined;

  const envBlock = environments[env];
  if (!isRecord(envBlock)) return undefined;

  const token = envBlock.fortmesa_api_token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * The signed-in user, as returned by the BE REST endpoint `GET /api/v2/me`
 * (NOT an MCP tool — a plain authenticated REST call). Today the endpoint returns
 * `{ email, displayName, userId, profileImage }`; `identityProvider` is
 * future-proofing (see `fetchIdentity`) and is `undefined` until a BE
 * follow-up on the FMWEB-3068 branch adds it. Used by the two Saferoom
 * identity surfaces (the Identity tree panel and the Settings webview's
 * Identity mirror) to show the real user instead of only the env name.
 */
export interface Identity {
  readonly email: string;
  readonly displayName: string;
  readonly userId: string;
  readonly profileImage?: string;
  readonly identityProvider?: string;
}

/**
 * Short timeout for the best-effort `/api/v2/me` identity lookup. Both
 * identity surfaces run it on passive background refreshes and degrade to the
 * env/JWT-only display when it doesn't answer, so it must never block a
 * refresh for long — and on the sandbox dev BE (the only place the endpoint
 * currently exists) an unreachable port must fail fast, not hang.
 */
const IDENTITY_FETCH_TIMEOUT_MS = 4000;

/**
 * Best-effort `GET <baseUrl>/api/v2/me` lookup of the signed-in user. Takes an
 * already-resolved `baseUrl`/`token` so this
 * module stays free of any `resolveCredentials` import — the caller supplies
 * both from `resolveCredentials(env)`.
 *
 * Returns `undefined` — NEVER throws — on ANY failure (unreachable/timed-out
 * connection, non-OK status such as the 404 you get on next/latest/prod where
 * the FMWEB-3068 endpoint isn't deployed yet, non-JSON body, or a body with no
 * usable `email`). Callers treat `undefined` as "couldn't enrich" and fall
 * back to the current env/JWT display, so the panels never break. Never logs
 * the token or the returned email.
 */
export async function fetchIdentity(baseUrl: string, token: string): Promise<Identity | undefined> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v2/me`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }

  if (!response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;

  // `email` is the guaranteed field AND the primary-label fallback — with no
  // usable email there is no identity worth showing, so degrade to undefined.
  const email = typeof body.email === 'string' ? body.email : '';
  if (email.length === 0) return undefined;

  const displayName = typeof body.displayName === 'string' ? body.displayName : '';
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const profileImage =
    typeof body.profileImage === 'string' && body.profileImage.length > 0 ? body.profileImage : undefined;
  // Future-proofing only: `/api/v2/me` does NOT return an identity provider
  // today. Consume `identityProvider` (or a `provider` alias) IF a later BE
  // revision adds one; otherwise leave it undefined and the tooltip shows just
  // the email. Delivering the provider needs a one-line BE addition on the
  // FMWEB-3068 branch (derive it from `FmwebUser.username`, e.g.
  // `google-oauth2|123` -> `google`).
  const identityProvider =
    typeof body.identityProvider === 'string' && body.identityProvider.length > 0
      ? body.identityProvider
      : typeof body.provider === 'string' && body.provider.length > 0
        ? body.provider
        : undefined;

  return {
    email,
    displayName,
    userId,
    ...(profileImage !== undefined ? { profileImage } : {}),
    ...(identityProvider !== undefined ? { identityProvider } : {}),
  };
}

/**
 * Primary display label for a resolved identity: the user's FIRST NAME (the
 * first whitespace-delimited token of `displayName`) when `displayName` is
 * non-empty, else the `email`. Pure and `vscode`-free so the Identity tree
 * panel (`tree-view.ts`) and the Settings webview (`saferoom-settings.ts`)
 * derive it identically from ONE implementation — unit-tested in
 * test/registry/identity-display.test.mjs.
 */
export function identityPrimaryLabel(identity: Identity): string {
  const fullName = identity.displayName.trim().replace(/\s+/g, ' ');
  return fullName.length > 0 ? fullName : identity.email;
}

/**
 * Hover-tooltip identity line: `<email> / <provider>` when an identity
 * provider is known, otherwise just `<email>`. Since `/api/v2/me` does not
 * return a provider today (see `fetchIdentity`), the email-only form is what
 * renders in practice until the FMWEB-3068 BE follow-up adds one. Pure and
 * `vscode`-free — shared by both identity surfaces.
 */
export function identityTooltip(identity: Identity): string {
  const provider = identity.identityProvider;
  return provider !== undefined && provider.length > 0 ? `${identity.email} / ${provider}` : identity.email;
}

/**
 * Locale/zone options for {@link formatExactExpiry}.
 *
 * `toLocaleString()` with NO options already renders in the host's LOCALE and
 * LOCAL TIME ZONE — that part was never wrong. What it omits is which zone,
 * and an absolute stamp with no zone is ambiguous to the person reading it
 * (PO, 2026-09-10). Every date/time component therefore has to be listed
 * explicitly: naming `timeZoneName` alone suppresses the implicit defaults and
 * would render the zone abbreviation and nothing else.
 */
const EXACT_EXPIRY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};

/**
 * Exact, absolute expiry stamp for the hover tooltip and the Identity table
 * (PO, 2026-09-03: the tooltip carries the "exact datestamp of expiration",
 * the list row carries only the relative time). `undefined` renders as
 * "unknown" rather than a blank so an undecodable token never produces a
 * dangling label.
 */
export function formatExactExpiry(expiry: Date | undefined): string {
  return expiry !== undefined ? expiry.toLocaleString(undefined, EXACT_EXPIRY_FORMAT) : 'unknown';
}

/**
 * Relative time until `expiry`, for the Identity list row (PO, 2026-09-03:
 * "relative time until expiration"). Coarse by design — a token's remaining
 * life is a glanceable fact, not a countdown: whole days, then whole hours,
 * then whole minutes, then "under a minute", and "expired" once it is past.
 *
 * `now` is injectable so this is deterministically testable without faking
 * the clock; callers pass nothing and get `Date.now()`.
 */
export function formatRelativeExpiry(expiry: Date | undefined, now: Date = new Date()): string {
  if (expiry === undefined) return 'expiry unknown';

  const deltaMs = expiry.getTime() - now.getTime();
  if (deltaMs <= 0) return 'expired';

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'expires in under a minute';
  if (minutes < 60) return `expires in ${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expires in ${String(hours)} h`;

  const days = Math.floor(hours / 24);
  return `expires in ${String(days)} d`;
}
