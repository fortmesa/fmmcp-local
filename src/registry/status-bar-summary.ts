/**
 * The pure, `vscode`-free half of the Saferoom status-bar projector
 * (VSIX-PLAN.md §3.1: `src/registry/**` stays vscode-free so it is
 * importable by both the CLI and the extension, and — the reason it lives
 * here rather than alongside `createStatusBar` in `extension/status-bar.ts`
 * — so its unit tests can import it directly with plain Node, without
 * pulling in the `vscode` module that only resolves inside a real extension
 * host).
 *
 * PO, 2026-09-09: the bar used to list every accessible scope
 * (`GRC: barsoommsp, sandbox-a, sandbox-b`), which becomes unreadable once a
 * user has more than a couple. It now shows exactly one of five states.
 */

/** Mirrors `Config['scopeLock']['mode']` (registry/config.ts) without importing the schema — this module only needs the three literal values. */
export type ScopeLockMode = 'single' | 'multi' | 'unlocked';

/** Inputs to the status-bar text projector. */
export interface StatusBarScopeState {
  /** Whether the active env has a non-expired credential. `false` wins over everything else. */
  readonly signedIn: boolean;
  readonly mode: ScopeLockMode;
  /** The accessible-scope set for `mode: "single" | "multi"`; ignored (but harmless) when `mode === "unlocked"`. */
  readonly scopes: readonly string[];
}

/**
 * Pure projector: `StatusBarScopeState` -> the text that follows `GRC: ` in
 * the status bar (never includes the icon or the `GRC:` prefix — those are
 * fixed in `extension/status-bar.ts`'s `paint()`). Five states, in priority
 * order:
 *
 * 1. Not signed in (no valid credential for the active env) -> "Not signed-in",
 *    regardless of scope count — PO: "if its not signed in .. we should still
 *    say 'Not signed-in'", even for an otherwise-single-scope lock.
 * 2. Signed in + `mode: "unlocked"` (Run unlocked) -> "Connected", because
 *    unlocked mode has no fixed scope list to name (it "includes scopes added
 *    later" — see the Scopes pane's own copy).
 * 3. Signed in + exactly one accessible scope -> the scope name itself.
 * 4. Signed in + zero accessible scopes -> "Connected · no scopes". Zero
 *    accessible scopes is a legal, deliberate state (2026-09-03 Scopes-pane
 *    round made it so) rather than an error, so the text says "you are
 *    connected, and this is the (valid) reason nothing is listed" rather than
 *    silently reusing "Not signed-in" — which would be actively misleading:
 *    the credential is fine, and conflating the two collapses a recoverable
 *    "adjust your scope selection" state into the un-recoverable-without-
 *    re-auth "sign in again" state.
 * 5. Signed in + more than one accessible scope -> "Connected" (bare) — the
 *    long list is exactly the unwieldiness the PO asked to remove; the full
 *    list still lives in the tooltip via `scopeListTooltip` below.
 */
export function statusBarSummaryFor(state: StatusBarScopeState): string {
  if (!state.signedIn) return 'Not signed-in';
  if (state.mode === 'unlocked') return 'Connected';
  if (state.scopes.length === 1) return state.scopes[0] ?? 'Connected';
  if (state.scopes.length === 0) return 'Connected · no scopes';
  return 'Connected';
}

/**
 * Render the full accessible-scope list for the tooltip (the one place the
 * PO's "GRC: <scopes>" detail still lives once the bar text itself collapses
 * to a single word). Truncated at 10 names with a "+n more" tail so a very
 * large scope set can't blow out the tooltip the way it used to blow out the
 * status bar itself. `undefined` for an empty list — the tooltip's default
 * sentence already covers that case.
 */
export function scopeListTooltip(scopes: readonly string[]): string | undefined {
  if (scopes.length === 0) return undefined;
  const MAX = 10;
  if (scopes.length <= MAX) return scopes.join(', ');
  return `${scopes.slice(0, MAX).join(', ')} (+${String(scopes.length - MAX)} more)`;
}
