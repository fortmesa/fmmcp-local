/**
 * How one row of the **Scope selector** presents its access state, and in
 * what order the rows appear.
 *
 * This is a `vscode`-free module ON PURPOSE, and the reason is a bug it now
 * makes impossible to reintroduce silently.
 *
 * The 2026-09-03 UX round removed the "this will unlock ALL scopes"
 * confirmation modal, on the stated grounds that the row icons already carry
 * the state. That premise did not hold. `tree-view.ts` built its active-scope
 * set as `new Set(mode === 'unlocked' ? [] : scopes)`, so in unlocked mode
 * NO row was active and every row fell through to the same neutral
 * `circle-large-outline` with no description that a locked-but-not-selected
 * row uses. "Every scope is reachable" and "this is not the scope you locked
 * to" were pixel-identical — precisely the distinction the removed modal had
 * been carrying. Dropping a guard while its replacement signal is ambiguous
 * is worse than keeping the guard.
 *
 * It survived review because the decision lived inside a module that imports
 * `vscode`, which no unit test in this repo can load. So the fix is
 * structural rather than a patched branch: the presentation decision lives
 * here as a pure function over plain strings, `tree-view.ts` does nothing but
 * turn `icon`/`iconColor` into a `vscode.ThemeIcon`, and
 * `test/registry/scope-display.test.mjs` asserts the three states stay
 * pairwise distinct to the eye. (Same move, and same motivation, as
 * `src/shared/errors.ts`.)
 *
 * ⚠️ The distinctness of these three presentations is load-bearing for the
 * absence of the unlock confirmation. If you collapse two of them, restore
 * the confirmation in `switchers.ts` in the same change.
 *
 * VOCABULARY (PO, 2026-09-08). The user-facing word is **Accessible** — the
 * agent may act in this scope — or **Inaccessible**. "Locked"/"unlocked" is
 * gone from every string a person reads, because the codebase used it in two
 * incompatible senses: "Saferoom is locked TO these scopes" (members are the
 * REACHABLE ones) and a row badge reading "locked" (which a user takes to
 * mean "shut out"). The internal names — `scopeLock`, `ScopeLock`,
 * `--scope-lock`, the `single|multi|unlocked` mode values — are UNCHANGED:
 * they are the on-disk config contract and a rename there is a migration,
 * not a copy fix.
 */

/**
 * What a scope row is saying:
 *  - `unlocked` — no scope lock at all; every authorized scope is reachable.
 *  - `locked-here` — the lock is on, and this row is (one of) its members.
 *  - `locked-elsewhere` — the lock is on, and this row is NOT reachable.
 */
export type ScopeRowState = 'unlocked' | 'locked-here' | 'locked-elsewhere';

/** Presentation for one scope row, as plain ids the caller maps to VS Code types. */
export interface ScopeRowPresentation {
  readonly state: ScopeRowState;
  /** Codicon id (no `$()` wrapper). */
  readonly icon: string;
  /** `ThemeColor` id, when the state is worth colouring. */
  readonly iconColor?: string;
  /** The row's trailing description. Absent means "render no description". */
  readonly description?: string;
  readonly tooltip: string;
}

/**
 * Decide one row's presentation from the scope-lock state.
 *
 * `mode` is the AUTHORITY on lockedness, never `lockedScopes.length` — the
 * same rule `resolveEffectiveStartup` follows (`scopeLocked = mode !==
 * 'unlocked'`) and the same one `ScopeLock`'s private constructor exists to
 * enforce. A locked mode with an empty scope set therefore denies every row
 * (fail closed), and a stale non-empty `scopes` array left behind by a
 * previous lock does not make an unlocked row look locked.
 */
export function scopeRowPresentation(
  mode: string,
  lockedScopes: readonly string[],
  scopeName: string,
): ScopeRowPresentation {
  if (mode === 'unlocked') {
    return {
      state: 'unlocked',
      // `globe` rather than the open padlock it used to be: the padlock was
      // the last piece of lock vocabulary left in this row, and it read as
      // "insecure" rather than "every scope". Distinctness from the other two
      // states is preserved by icon + colour (see the pairwise-distinct
      // regression test), which is what the absent unlock confirmation rests on.
      icon: 'globe',
      iconColor: 'charts.yellow',
      description: 'accessible',
      tooltip: `Every scope is accessible. Click to make ${scopeName} the only accessible scope.`,
    };
  }

  if (lockedScopes.includes(scopeName)) {
    return {
      state: 'locked-here',
      icon: 'pass-filled',
      iconColor: 'charts.green',
      description: 'accessible',
      tooltip: `${scopeName} is accessible.`,
    };
  }

  return {
    state: 'locked-elsewhere',
    icon: 'circle-slash',
    description: 'inaccessible',
    tooltip: `${scopeName} is inaccessible. Click to make it the only accessible scope.`,
  };
}

/**
 * Order the **Scope selector**'s rows: accessible first, then inaccessible,
 * alphabetical (case-insensitive) within each group.
 *
 * PO, 2026-09-08: *"reorder scope selector such that 'available scopes'
 * appear first, followed by unavailable scopes in the primary sidebar (but
 * keep alphabetic in the multi-select screen)."* The multi-select table
 * deliberately does NOT use this — a table whose rows jump between groups as
 * you tick them is unusable, so that surface sorts by name alone.
 *
 * In `unlocked` mode every row is accessible, so this degrades to a plain
 * alphabetical sort. Pure and total: ties break on the original name so the
 * result is deterministic for names differing only in case.
 */
export function compareScopeRows(mode: string, accessibleScopes: readonly string[], a: string, b: string): number {
  const rank = (name: string): number =>
    scopeRowPresentation(mode, accessibleScopes, name).state === 'locked-elsewhere' ? 1 : 0;
  const byGroup = rank(a) - rank(b);
  if (byGroup !== 0) return byGroup;
  const byName = a.toLowerCase().localeCompare(b.toLowerCase());
  return byName !== 0 ? byName : a.localeCompare(b);
}

/** {@link compareScopeRows} applied to a list of rows carrying a `name`. Returns a new array; never mutates the input. */
export function sortScopeRows<T extends { readonly name: string }>(
  mode: string,
  accessibleScopes: readonly string[],
  rows: readonly T[],
): T[] {
  return [...rows].sort((x, y) => compareScopeRows(mode, accessibleScopes, x.name, y.name));
}
