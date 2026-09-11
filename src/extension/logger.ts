import * as vscode from 'vscode';
import type { Config } from '../registry/config.js';

/**
 * Minimal, vscode-shape-erased logging port used by every extension module
 * below `extension.ts` (`mcp-provider.ts`, `settings-sync.ts`,
 * `tree-view.ts`, `status-bar.ts`, `ide-sync-commands.ts`).
 *
 * Keeping the *interface* free of any `vscode.*` type — even though the one
 * production implementation below wraps a `vscode.LogOutputChannel` — means
 * the pure logic in those modules (e.g. `settings-sync.ts`'s `configEquals`
 * and reconciliation-decision helpers) can be exercised with a plain fake
 * `Logger` in a Node unit test, without spinning up a real extension host.
 * `no-console` is an error repo-wide (this is a JSON-RPC-adjacent codebase —
 * see GEMINI.md / curriculum 07 — even though the extension host itself
 * isn't a stdio process, the lint config draws no exception for it), so this
 * `Logger` port, backed by the OutputChannel, is the only sanctioned way
 * anything under `src/extension/**` reports what it's doing.
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Update the minimum level this logger emits at (see `setLevel`). */
  setLevel(level: Config['logLevel']): void;
}

const LEVEL_RANK: Record<Config['logLevel'], number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Wrap a real `vscode.LogOutputChannel` as a `Logger`.
 *
 * The extension's OutputChannel level and `~/.fmcode/config.json`'s
 * `logLevel` are two independent knobs at the VS Code UI layer (the channel
 * is still filtered by VS Code's own `env.logLevel` / per-channel level UI
 * regardless of what's written here), but `config.json`'s `logLevel` now
 * additionally gates which calls reach the channel at all: `setLevel` (wired
 * from `extension.ts`'s `applyConfig` to `config.logLevel` on every load/
 * reload) drops calls below the configured threshold before they ever reach
 * `channel.*`. `config.json`'s `logLevel` does not affect the local MCP
 * proxy's own stderr verbosity, which is a separate process (see TODOS).
 */
export function createLogger(channel: vscode.LogOutputChannel): Logger {
  let threshold = LEVEL_RANK.info;
  const emit = (level: Config['logLevel'], message: string): void => {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }
    channel[level](message);
  };
  return {
    debug: (message: string): void => {
      emit('debug', message);
    },
    info: (message: string): void => {
      emit('info', message);
    },
    warn: (message: string): void => {
      emit('warn', message);
    },
    error: (message: string): void => {
      emit('error', message);
    },
    setLevel: (level: Config['logLevel']): void => {
      threshold = LEVEL_RANK[level];
    },
  };
}

/**
 * Re-exported from `src/shared/errors.ts` so every existing
 * `import { errorMessage } from './logger.js'` site keeps working while the
 * function itself stays importable without `vscode` — see that module.
 */
export { errorMessage } from '../shared/errors.js';
