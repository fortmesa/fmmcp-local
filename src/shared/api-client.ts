import type { ApiFetchOptions } from './types.js';

/**
 * Minimal authenticated fetch client for the FortMesa Continurisk API.
 *
 * Trimmed copy of fmmcp-gw's api-client: credentials are resolved by the
 * TokenProvider chain (src/local-mcp/auth/token-provider.ts) and injected once
 * at startup via setApiCredentials() — this module holds no resolution logic.
 * Used only by the LOCAL tools (documents); everything else is proxied to the
 * gateway with the bearer attached at the transport layer.
 */

/**
 * Error thrown by apiFetch() on a non-2xx response.
 *
 * Carries the machine-readable `code`/`details` from the upstream error body
 * alongside the plain-text `message` (mirrors fmmcp-gw's `ApiError` — see that
 * repo's src/shared/api-client.ts for the full body-shape rationale: fmweb-be's
 * LoopbackErrorHandlerProvider emits a flat body — `{status, title, detail,
 * code, details, ...}` — for every `createHttpError(status, msg, {expose:true,
 * code:'...'})` call site). ApiError IS an Error (same `message` text shape:
 * `HTTP <status>: <reason> [<method> <path>]`) so every existing string-matching
 * caller keeps working unmodified; callers that need the machine code use
 * apiErrorCode()/apiErrorStatus()/apiErrorDetails() (src/shared/tool-helpers.ts)
 * instead of string-matching the message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let _token: string | undefined;
let _baseUrl: string | undefined;
let _provider: CredentialProvider | undefined;

/** Resolves current credentials. Consulted on EVERY request, not captured once. */
export type CredentialProvider = () => Promise<{ token: string; baseUrl: string }>;

/**
 * Install a resolver consulted before every request.
 *
 * This exists because the static form below is wrong for a long-running proxy.
 * A token captured at startup is used unchanged for the life of the process:
 * it is never re-read, so a `login` performed while the proxy runs is
 * invisible, and it is never re-checked, so an expiry mid-session goes
 * unnoticed. The expiry gate and refresh in `resolveCredentials` only run when
 * something calls it, and the proxy called it exactly once.
 *
 * A provider fixes both. `resolveCredentials` re-reads credentials.json,
 * refreshes an expiring token, and refuses an expired one, so every request
 * gets a credential that is currently valid rather than one that was valid at
 * boot.
 */
export function setCredentialProvider(provider: CredentialProvider): void {
  _provider = provider;
}

/**
 * Tell an installed provider which environment to resolve from now on.
 *
 * Returns false when no provider is installed, so the caller knows to fall
 * back to fixed credentials rather than silently doing nothing.
 */
export function onCredentialEnvChange(env: string | undefined): boolean {
  if (_provider === undefined) return false;
  if (env !== undefined) _envHint = env;
  return true;
}

/** The env the installed provider should resolve. Updated on an env switch. */
let _envHint: string | undefined;

/** Read by the provider installed in cli.ts. */
export function currentCredentialEnv(fallback: string): string {
  return _envHint ?? fallback;
}

/**
 * Install fixed credentials.
 *
 * For one-shot CLI subcommands, where the process exits long before anything
 * could expire. A long-running server should use {@link setCredentialProvider}.
 */
export function setApiCredentials(token: string, baseUrl: string): void {
  _token = token;
  _baseUrl = baseUrl.replace(/\/+$/, '');
  _provider = undefined;
}

/**
 * Make an authenticated API request to the FortMesa Continurisk API.
 * Uses Node 24 native fetch. Requires setApiCredentials() first.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<unknown> {
  // Resolved per request when a provider is installed, so an expiring token is
  // refreshed and a token written by a mid-session login is picked up.
  let token = _token;
  let baseUrl = _baseUrl;
  if (_provider !== undefined) {
    const current = await _provider();
    token = current.token;
    baseUrl = current.baseUrl.replace(/\/+$/, '');
  }

  if (token === undefined || baseUrl === undefined) {
    throw new Error('API credentials not initialized. Call setApiCredentials() or setCredentialProvider() at startup.');
  }

  const url = new URL(`${baseUrl}${path}`);
  if (options.params !== undefined) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.append(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // 50s, deliberately UNDER the MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC of
  // 60_000. That is the caller's own per-request budget for the tool call this
  // runs inside. Matching it exactly would leave this still waiting upstream at
  // the instant the caller cancels, so the upstream error could never be mapped
  // and returned; the user would see a bare cancellation instead of a reason.
  // The 10s gap is room to receive the failure, map it, and serialize a reply.
  //
  // One absolute wall-clock deadline, not an idle timeout: AbortSignal.timeout
  // covers connect, sending the request body, waiting for response headers, AND
  // reading the response body, and never resets on progress (measured on
  // Node 24).
  //
  // Callers moving a large body override it: 50MB, the API's upload ceiling,
  // needs ~40s of transfer at 10 Mbps up and ~80s at 5 Mbps.
  const timeoutMs = options.timeoutMs ?? 50_000;

  const fetchConfig: RequestInit = {
    redirect: options.redirect ?? 'follow',
    method: options.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (options.rawBody !== undefined) {
    // Multipart or other pre-built body. fetch sets Content-Type itself only
    // for a FormData it serializes; a Buffer arrives with the boundary already
    // baked in, so the caller passes the header through options.headers.
    fetchConfig.body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchConfig.body = JSON.stringify(options.body);
  }

  if (options.headers !== undefined) Object.assign(headers, options.headers);

  let response: Response;
  try {
    response = await fetch(url.toString(), fetchConfig);
  } catch (fetchError: unknown) {
    if (fetchError instanceof DOMException && fetchError.name === 'TimeoutError') {
      throw new Error(
        `Request timed out after ${String(timeoutMs)}ms — the API did not respond. ` +
          `This often indicates an authentication problem (invalid/expired JWT causing the auth middleware to hang). ` +
          `[${options.method ?? 'GET'} ${url.pathname}]`,
        { cause: fetchError },
      );
    }
    throw fetchError;
  }

  // A manual redirect is the point of the call, not a failure, so it comes back
  // before the !ok handling below would turn a 302 into an error.
  if (options.redirect === 'manual' && response.status >= 300 && response.status < 400) {
    return response;
  }

  if (!response.ok) {
    let errorMessage: string;
    let code: string | undefined;
    let details: unknown;
    try {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText) as {
          detail?: string;
          title?: string;
          code?: string;
          details?: unknown;
          error?: { message?: string; code?: string; details?: unknown } | string;
          message?: string;
        };
        // Parse order matches fmmcp-gw's api-client: flat body (fmweb-be's actual
        // shape — body.{detail,title,code,details}) → nested LB4 shape
        // (body.error.{message,code,details}, unconfirmed producer, kept for
        // tolerance) → legacy flat shape (body.message / body.error as a string) → raw text.
        if (typeof errorData.code === 'string' || typeof errorData.detail === 'string') {
          errorMessage = errorData.detail ?? errorData.title ?? errorText.slice(0, 300);
          code = errorData.code;
          details = errorData.details;
        } else if (errorData.error !== undefined && typeof errorData.error === 'object') {
          errorMessage = errorData.error.message ?? errorText.slice(0, 300);
          code = errorData.error.code;
          details = errorData.error.details;
        } else if (typeof errorData.message === 'string') {
          errorMessage = errorData.message;
        } else if (typeof errorData.error === 'string') {
          errorMessage = errorData.error;
        } else {
          errorMessage = errorText.slice(0, 300);
        }
      } catch {
        errorMessage = errorText.slice(0, 300);
      }
    } catch {
      errorMessage = `HTTP ${String(response.status)} ${response.statusText}`;
    }
    throw new ApiError(
      `HTTP ${String(response.status)}: ${errorMessage} [${options.method ?? 'GET'} ${url.pathname}]`,
      response.status,
      code,
      details,
    );
  }

  // Return raw Response for binary downloads
  if (options.rawResponse === true) {
    return response;
  }

  return response.json();
}
