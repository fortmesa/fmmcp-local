/**
 * Scope lock enforcement for fmmcp-local.
 *
 * When the proxy is scope-locked, only the declared scopes are accessible.
 * Resolution is a local map lookup against the scopeMap in credentials.json —
 * no API calls, no caching.
 *
 * FORKLIFT-LANDED: relocated here from fmmcp-gw (the gateway's copy is the
 * transitional stdio-mode enforcement, excised once this CLI is adopted —
 * see fmmcp-gw TODOS T009).
 */

export interface AuthorizedScope {
  /** MongoDB ObjectId of the authorized scope. */
  readonly scopeId: string;
  /** Canonical name from the credentials scopeMap. */
  readonly name: string;
}

/**
 * Context the lock uses to word a rejection accurately.
 *
 * `knownScopes` is the identity's cached scopeMap (name -> scopeId) from
 * credentials.json. It is a CACHE, never an authority: a scopeId missing from
 * it means "not in the list we know about", NOT "you are not entitled to it".
 * The wording below is careful about that distinction — asserting
 * non-entitlement from a cache miss sends an agent away from a scope it could
 * actually have reached, which is worse than saying nothing.
 */
export interface ScopeLockContext {
  /** Environment name, for message context only. */
  readonly env?: string;
  /** Cached name -> scopeId map from credentials.json, if any. */
  readonly knownScopes?: Record<string, string>;
}

/**
 * Immutable scope lock state, constructed once at startup (and again on every
 * hot reload).
 *
 * The constructor is private ON PURPOSE. Lockedness used to be inferred as
 * `scopes.length > 0`, which made `mode: "single"` with `scopes: []` — a
 * reachable state, since mode and scopes are independent settings — permit
 * EVERY scope while the UI read "single (no scopes selected)". Callers must
 * now say which they mean: `ScopeLock.unlocked()` or `ScopeLock.lockedTo()`.
 * A lock with no members denies everything.
 */
export class ScopeLock {
  private readonly locked: boolean;
  private readonly authorized: ReadonlySet<string>;
  private readonly names: ReadonlyMap<string, string>;
  private readonly context: ScopeLockContext;

  private constructor(locked: boolean, scopes: AuthorizedScope[], context: ScopeLockContext) {
    this.locked = locked;
    this.authorized = new Set(scopes.map((s) => s.scopeId));
    this.names = new Map(scopes.map((s) => [s.scopeId, s.name]));
    this.context = context;
  }

  /** A lock permitting all scopes. Used when no scope lock is configured. */
  static unlocked(): ScopeLock {
    return new ScopeLock(false, [], {});
  }

  /**
   * A lock confined to `scopes`. An EMPTY array is a valid, meaningful input:
   * it means "locked, with nothing selected", and denies every scope.
   */
  static lockedTo(scopes: AuthorizedScope[], context: ScopeLockContext = {}): ScopeLock {
    return new ScopeLock(true, scopes, context);
  }

  /** True if this instance is scope-locked. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** The set of authorized scopeIds — used to filter grc_scopes list responses. */
  get authorizedIds(): ReadonlySet<string> {
    return this.authorized;
  }

  /**
   * This scope's display name, when the lock knows one.
   *
   * A name exists here exactly when the proxy is scope-locked to that scope,
   * which is exactly when the Scope selector in the sidebar is already
   * showing that name. The Event viewer relies on that equivalence: it may
   * print a scope NAME only when the name is already on screen, and falls
   * back to a six-character short id otherwise. See
   * `registry/events/summarize.ts`'s `scopeLabel`.
   */
  nameFor(scopeId: string): string | undefined {
    return this.names.get(scopeId);
  }

  /**
   * Assert that the given scopeId is authorized.
   * Throws a descriptive Error when locked and the ID is not in the authorized
   * set. Tool handlers catch this and return toolError().
   *
   * The message must carry ONE bit reliably: can the caller do anything about
   * this in-session, or not? The three branches below answer exactly that.
   *
   * ⚠️ These three strings are read by an AGENT, not by a person, and they are
   * long ON PURPOSE — they are what stops a model retrying a scope it can
   * never reach, or concluding "not entitled" from a local config choice. The
   * 2026-09-08 density pass across the extension's user-facing copy
   * deliberately did NOT touch their length; only the vocabulary changed
   * ("locked" → "accessible"/"inaccessible") so every surface says the same
   * thing.
   */
  assertAuthorized(scopeId: string): void {
    if (!this.locked || this.authorized.has(scopeId)) return;

    const lockedTo = [...this.names.values()];

    if (lockedTo.length === 0) {
      throw new Error(
        `No scope is accessible on this Saferoom instance — every scope is refused, including ` +
          `"${scopeId}". This is a LOCAL Saferoom configuration, not your account permissions. ` +
          `Ask the user to make a scope accessible in the FortMesa Saferoom sidebar, then retry.`,
      );
    }

    const lockedSummary =
      lockedTo.length === 1
        ? `"${lockedTo[0] ?? ''}"`
        : `${String(lockedTo.length)} scope(s): [${lockedTo.join(', ')}]`;

    const knownName = this.knownNameFor(scopeId);
    if (knownName !== undefined) {
      throw new Error(
        `Scope "${knownName}" (${scopeId}) is inaccessible on this Saferoom instance — a LOCAL ` +
          `configuration, not your account permissions. The accessible scopes are ${lockedSummary}. ` +
          `Ask the user to make this scope accessible in the FortMesa Saferoom sidebar, then retry.`,
      );
    }

    const envSuffix = this.context.env === undefined ? '' : ` for environment "${this.context.env}"`;
    throw new Error(
      `Scope "${scopeId}" is not in this identity's known scope list${envSuffix}, and this Saferoom ` +
        `instance separately makes only ${lockedSummary} accessible. The scope may not exist, may not be ` +
        `granted to this account, or the cached scope list may be stale — ask the user to refresh scopes ` +
        `in the FortMesa Saferoom sidebar. Do not retry this scope without that.`,
    );
  }

  /** Reverse-lookup a scopeId in the cached scopeMap. Returns undefined when absent or uncached. */
  private knownNameFor(scopeId: string): string | undefined {
    const known = this.context.knownScopes;
    if (known === undefined) return undefined;
    for (const [name, id] of Object.entries(known)) {
      if (id === scopeId) return name;
    }
    return undefined;
  }
}

/**
 * Resolve an array of scope names to AuthorizedScope entries using the scopeMap
 * from credentials.json.
 *
 * - Name matching is case-insensitive (both input and map key are lowercased).
 * - The canonical name stored is the map key's original casing.
 * - Fails fast if scopeMap is absent or any name cannot be resolved.
 *
 * @param names   Parsed --scope-lock names (already trimmed, non-empty).
 * @param scopeMap The env credential's scopeMap (name → scopeId), may be undefined.
 * @param env     Environment name — used in error messages only.
 */
export function resolveScopeLock(
  names: string[],
  scopeMap: Record<string, string> | undefined,
  env: string,
): AuthorizedScope[] {
  if (names.length === 0) return [];

  if (scopeMap === undefined || Object.keys(scopeMap).length === 0) {
    throw new Error(
      `--scope-lock requires a "scopeMap" in credentials for env "${env}". ` +
        `Add a scopeMap: { "scope-name": "scopeId" } block to the "${env}" environment in ~/.fmcode/credentials.json.`,
    );
  }

  // Build a lowercase-keyed index for case-insensitive lookup.
  // Preserves the original map key as canonical name.
  const index = new Map<string, { canonicalName: string; scopeId: string }>();
  for (const [k, v] of Object.entries(scopeMap)) {
    index.set(k.toLowerCase(), { canonicalName: k, scopeId: v });
  }

  const resolved: AuthorizedScope[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    const entry = index.get(name.toLowerCase());
    if (entry === undefined) {
      unresolved.push(name);
    } else {
      resolved.push({ scopeId: entry.scopeId, name: entry.canonicalName });
    }
  }

  if (unresolved.length > 0) {
    const known = [...index.keys()].join(', ');
    throw new Error(
      `Scope name(s) not found in scopeMap for env "${env}": [${unresolved.join(', ')}]. ` + `Known scopes: [${known}]`,
    );
  }

  return resolved;
}
