import type { IdentityChangeKind } from './identity-change.js';

/**
 * The extension's identity-change signal.
 *
 * ## The gap it fills (verified, not assumed)
 *
 * There was no way for anything but the Signed-in user view to learn that
 * credentials changed. `extension/identity-view.ts`'s `signOut` handler clears
 * the stored token and then calls `this.postState()` — its own webview and
 * nothing else. The Scope selector tree, the status bar and an open Accessible
 * scopes panel were never told, so they kept rendering the previous identity's
 * scopes, and the sidebar kept claiming those scopes were accessible.
 *
 * The only refresh fan-out that reaches all of them is `extension.ts`'s
 * `applyConfig`, and that is driven by `watchConfig` — a watcher on
 * **config.json**. Signing in, signing out and pasting a token all write
 * **credentials.json**, which nothing watches. Environment switching, by
 * contrast, *is* a config.json write, which is why it already worked and why
 * it needs nothing here. `sign-in-session.ts` already carried the observation
 * ("credentials.json has no watcher (only config.json does), so the tree views
 * never learn a token appeared without this") and reached for
 * `fortmesa.refresh` — which refreshes the three trees and neither webview
 * panel. That half-fix is what left the panel stale.
 *
 * ## Why an event rather than the two obvious alternatives
 *
 *  - **Watch credentials.json.** It holds bearer tokens; adding a durable
 *    read/watch surface on it to drive a cosmetic refresh is the wrong trade,
 *    and it would fire on every silent token refresh (`token-refresh.ts`) —
 *    a refresh is not an identity change.
 *  - **Call `fortmesa.refresh` from each site.** It is precisely the too-narrow
 *    fan-out that caused this bug, so reusing it would re-create it.
 *
 * ## Why it is hand-rolled rather than a `vscode.EventEmitter`
 *
 * Two of its three firing sites are modules that import no `vscode` at all,
 * and `test/registry/auth-actions.test.mjs` exercises `auth-commands.ts`
 * *because of that* — "the module imports no `vscode` — see its doc comment".
 * A `vscode.EventEmitter` here would have quietly taken that property away and
 * broken three existing suites. Emitter semantics this small (subscribe,
 * fire, dispose) are not worth a dependency that costs testability, so the
 * listener set is twelve lines and this module is `vscode`-free like the rest
 * of `registry/` (VSIX-PLAN.md §3.1) — which also makes the fan-out itself
 * assertable.
 */
export interface IdentityChange {
  readonly kind: IdentityChangeKind;
  /** The environment whose credentials changed. */
  readonly env: string;
  /**
   * The new identity's display label, when the firing site already knows it.
   * Never fetched for the sake of this event — the panel would otherwise have
   * to make a network call to name the person it is telling you about.
   */
  readonly label?: string;
}

export type IdentityChangeListener = (change: IdentityChange) => void;

/** Structurally a `vscode.Disposable`, so it drops straight into `context.subscriptions`. */
export interface IdentityChangeSubscription {
  dispose(): void;
}

const listeners = new Set<IdentityChangeListener>();

/** Subscribe to identity changes. Dispose to unsubscribe; disposing twice is a no-op. */
export function onIdentityChanged(listener: IdentityChangeListener): IdentityChangeSubscription {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

/**
 * Announce that the stored credentials for an environment changed.
 *
 * Iterates a COPY: a listener that unsubscribes itself while being notified
 * (the scope panel does exactly this, on dispose) must not perturb the
 * in-progress fan-out. One listener throwing must not silence the rest, so
 * each is called in isolation.
 */
export function notifyIdentityChanged(change: IdentityChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // A listener's own failure is its own problem; the other surfaces still
      // need to hear about the identity change.
    }
  }
}

/** Drop every listener. Registered by `extension.ts` so nothing survives an extension-host teardown. */
export function disposeIdentityEvents(): IdentityChangeSubscription {
  return {
    dispose: () => {
      listeners.clear();
    },
  };
}
