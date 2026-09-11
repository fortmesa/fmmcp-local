/**
 * What the scope surfaces say when the signed-in identity changes underneath
 * them.
 *
 * PO, 2026-09-08: *"When auth state changes (new session selected …) scope
 * selector is no longer valid but state is not refreshed."* That was
 * literally true: `identity-view.ts`'s sign-out handler cleared the
 * credentials and then refreshed **its own view only**, and the one refresh
 * fan-out that reaches the scope panel and the trees is driven by
 * `watchConfig` — i.e. by **config.json** — while signing in and out writes
 * **credentials.json**, which nothing watches. So an open panel kept
 * rendering the previous identity's scope list.
 *
 * The event that fixes it is `extension/identity-events.ts`; this module is
 * the part of it that is a decision about words rather than about plumbing,
 * so it lives here where a test can reach it.
 *
 * `vscode`-free on purpose (VSIX-PLAN.md §3.1).
 */

/** Why the identity changed. `signed-out` is the one case with no new identity to name. */
export type IdentityChangeKind = 'signed-in' | 'signed-out';

/**
 * One line for the scope panel's notice strip.
 *
 * `label` is passed by whichever site made the change (it already knows the
 * identity — the panel would otherwise have to make a network call to find
 * out, which is exactly what "no additional calls" rules out). When it is
 * absent — a pasted token whose identity probe failed, say — the line still
 * has to be true, so it names the event rather than the person.
 */
export function identityChangeNotice(kind: IdentityChangeKind, label?: string): string {
  if (kind === 'signed-out') return 'Signed out — scopes are no longer available.';
  const named = label?.trim() ?? '';
  return named.length > 0 ? `Signed in as ${named} — scopes reloaded` : 'Identity changed — scopes reloaded';
}
