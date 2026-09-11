/**
 * Per-environment credentials block within ~/.fmcode/credentials.json.
 */
export interface FortMesaEnvCredentials {
  readonly fortmesa_api_token: string;
  readonly fortmesa_api_base: string;
  readonly generated_at: string;
  readonly expires_at: string;
  /**
   * Optional scope name → scopeId map used by --scope-lock at startup.
   * Keys are scope names (case-insensitive at lookup); values are MongoDB ObjectIds.
   * Maintained manually in ~/.fmcode/credentials.json per environment.
   */
  readonly scopeMap?: Record<string, string>;
}

/**
 * Options for the apiFetch() helper.
 */
export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Pre-built body (e.g. FormData for multipart). Bypasses JSON serialization. */
  rawBody?: FormData | Buffer | ReadableStream;
  /**
   * Extra request headers, merged over the defaults. A pre-built rawBody needs
   * these: fetch only derives Content-Type when it builds the body itself, and
   * a compressed body has to declare its Content-Encoding.
   */
  headers?: Record<string, string>;
  /** If true, return the raw Response object instead of parsing JSON. Used for binary downloads. */
  rawResponse?: boolean;
  /**
   * Set 'manual' to get the 3xx back instead of following it.
   *
   * The document download endpoint answers 302 with a presigned S3 URL in
   * Location. `download_url` hands that URL to the caller rather than fetching
   * the bytes, so following the redirect would pull the whole file down for
   * nothing.
   */
  redirect?: 'follow' | 'manual';
  /**
   * Total wall-clock budget for the request in milliseconds, covering connect,
   * request body, response headers and response body. Default: 50 000 ms.
   * Override it for any call that transfers a large body.
   */
  timeoutMs?: number;
}

/**
 * Uniform result shape every `src/registry/projectors/*` module returns, so
 * the sync engine (`src/registry/sync.ts`) can report on all targets alike.
 */
export interface ProjectorResult {
  readonly target: string;
  readonly action: 'added' | 'updated' | 'unchanged' | 'skipped' | 'error';
  readonly detail: string;
  readonly restartNote: string;
}

/**
 * The canonical server spec every projector receives: command + args only.
 * Environment and scope live in config.json, never in a projected entry.
 */
export interface FortmesaServerSpec {
  readonly command: string;
  readonly args: readonly string[];
}
