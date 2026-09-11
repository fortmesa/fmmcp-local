/**
 * Quarantine state for a failed hot reload.
 *
 * Why this exists: `reload()` deliberately mutates nothing when the new
 * gateway cannot be reached — the OLD gateway client and the OLD scope lock
 * keep serving. That is correct for availability and WRONG for safety: the
 * user has already moved on in the Saferoom UI, so the agent silently retains
 * access to the scope the user believes they left. The old lock still enforces
 * the old scope, and nothing tells anyone.
 *
 * So a failed reload puts the proxy in quarantine: every tools/call is refused
 * with an explicit, retryable error until a reload succeeds. The state is
 * honest (nobody is served from the stale binding) and visible (the agent
 * relays the reason to the user), and it clears itself the moment the next
 * reload lands.
 *
 * Tearing the proxy down instead was rejected: a transient gateway blip would
 * end the session unrecoverably, and the user would have no way back short of
 * restarting the IDE.
 */
export class ReloadState {
  private failure: string | undefined;

  /** Record a failed reload. Every subsequent call is refused until `markSucceeded`. */
  markFailed(detail: string): void {
    this.failure = detail;
  }

  /** Clear the quarantine after a reload completes successfully. */
  markSucceeded(): void {
    this.failure = undefined;
  }

  /** True while the proxy is quarantined by a failed reload. */
  get isQuarantined(): boolean {
    return this.failure !== undefined;
  }

  /**
   * The message to return for a refused call, or `undefined` when serving normally.
   *
   * It must say three things: that the refusal is a Saferoom-side failure and
   * not an authorisation decision, that the previous scope/environment is NOT
   * being served, and what the user can do.
   */
  get blockedReason(): string | undefined {
    if (this.failure === undefined) return undefined;
    return (
      `Saferoom could not apply the last environment/scope change and has stopped serving requests ` +
      `rather than continue on the previous environment and scope, which you no longer have the ` +
      `user's intent for. This is NOT an authorisation decision. Reason: ${this.failure}. ` +
      `Ask the user to re-apply the environment or scope in the FortMesa Saferoom sidebar ` +
      `(re-selecting it retries the reload), then retry this call.`
    );
  }
}
