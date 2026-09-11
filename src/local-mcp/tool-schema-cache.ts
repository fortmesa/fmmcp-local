/**
 * Cache of the gateway's published tool schemas.
 *
 * `tools/list` used to call the gateway on every single request. That is a
 * round trip an agent pays for repeatedly, and worse, it makes the tool list
 * unavailable whenever the gateway is briefly unreachable -- the agent then
 * sees NO tools rather than the ones it had a moment ago.
 *
 * Caching is what makes the schemas safe to take from the gateway at all. The
 * VSIX is installed by a user and rarely updated, so its own copy of a schema
 * freezes on the day it shipped; deriving from the gateway fixes that, but only
 * if the derivation is cheap enough to do constantly. So: serve from cache,
 * refresh when it expires, and keep serving the last good answer if a refresh
 * fails.
 *
 * The expiry is the gateway's to choose when it publishes one. MCP has no
 * standard field for it, so this reads `_meta` on the tools/list result and
 * falls back to a local default. A gateway that starts publishing an expiry
 * therefore changes this process's behaviour with no new VSIX.
 */

/** How long a fetched list stays good when the gateway names no expiry of its own. */
export const DEFAULT_SCHEMA_TTL_MS = 5 * 60 * 1000;

/** `_meta` key a gateway can set on tools/list to choose its own cadence. */
export const EXPIRES_AT_META_KEY = 'fortmesa/schemaExpiresAt';

export interface ToolListResult<TTool> {
  readonly tools: readonly TTool[];
  readonly _meta?: Record<string, unknown> | undefined;
}

/**
 * Read the gateway's chosen expiry, if it published one.
 *
 * Accepts an ISO timestamp (`schemaExpiresAt`) and ignores anything
 * unparseable or already past, so a malformed value degrades to the default
 * rather than pinning the cache open or forcing a fetch every call.
 */
export function expiryFromMeta(meta: Record<string, unknown> | undefined, nowMs: number): number | undefined {
  const raw = meta?.[EXPIRES_AT_META_KEY];
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed) || parsed <= nowMs) return undefined;
  return parsed;
}

export interface SchemaCacheOptions<TTool> {
  /** Fetch the live list from the gateway. */
  readonly fetchTools: () => Promise<ToolListResult<TTool>>;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export class ToolSchemaCache<TTool> {
  private cached: readonly TTool[] | undefined;
  private expiresAtMs = 0;
  private inFlight: Promise<readonly TTool[]> | undefined;

  private readonly fetchTools: () => Promise<ToolListResult<TTool>>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: SchemaCacheOptions<TTool>) {
    this.fetchTools = options.fetchTools;
    this.ttlMs = options.ttlMs ?? DEFAULT_SCHEMA_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  /** Drop the cache, so the next read refetches. Call on reload: the gateway may have changed. */
  invalidate(): void {
    this.cached = undefined;
    this.expiresAtMs = 0;
  }

  async get(): Promise<readonly TTool[]> {
    const nowMs = this.now();
    if (this.cached !== undefined && nowMs < this.expiresAtMs) return this.cached;

    // Collapse concurrent misses into one fetch; several agents asking at once
    // should not become several round trips.
    this.inFlight ??= this.refresh(nowMs).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(nowMs: number): Promise<readonly TTool[]> {
    try {
      const result = await this.fetchTools();
      this.cached = result.tools;
      this.expiresAtMs = expiryFromMeta(result._meta, nowMs) ?? nowMs + this.ttlMs;
      return this.cached;
    } catch (error: unknown) {
      // A stale list beats no list: an agent that momentarily sees zero tools
      // may drop them from its context entirely.
      if (this.cached !== undefined) {
        this.log(
          `tools/list refresh failed, serving cached schemas: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.cached;
      }
      throw error;
    }
  }
}
