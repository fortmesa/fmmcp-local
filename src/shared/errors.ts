/**
 * The one `unknown -> string` error renderer, in the only layer both the
 * `vscode`-free modules and `src/extension/**` may import.
 *
 * It used to live only in `src/extension/logger.ts` (which imports
 * `vscode`), which meant any module reaching for it — including the
 * auth actions in `auth-commands.ts` — became unloadable outside a real
 * extension host, and therefore untestable by a plain Node unit test. The
 * fail-closed rule those actions enforce (a token the gateway rejects is
 * never written to disk) is exactly the kind of thing that must be
 * testable, so the function moved down here. `logger.ts` re-exports it, so
 * every existing import site is unchanged.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
