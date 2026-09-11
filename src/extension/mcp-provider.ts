import * as vscode from 'vscode';
import type { Logger } from './logger.js';

/**
 * Registers the canonical `fortmesa` MCP server with VS Code's native
 * `vscode.lm.registerMcpServerDefinitionProvider` API (VSIX-PLAN.md §3.3,
 * curriculum 04 §2 / 05 "APIs you'll use").
 *
 * One provider, one static server spec (env/scope live in `config.json` and
 * never touch this spec — see VSIX-PLAN.md §3.3 "IDE config files are
 * written once and stay byte-stable"). `fireChanged()` is the only thing a
 * caller ever needs to invoke on registry change; VS Code re-calls
 * `provideMcpServerDefinitions` and reflects the (unchanged, by design)
 * result live, no restart.
 *
 * `getServerSpec` may return `undefined` to mean "serve no definition at
 * all" — this is how `config.json`'s `ideSync.vscode` opt-out (R3, F4) is
 * honored: the caller (`extension.ts`) returns `undefined` from its callback
 * whenever `ideSync.vscode` is `false`, and `provideMcpServerDefinitions`
 * reflects that as an empty list rather than the static spec.
 */

/** The static server spec projected to the `vscode.lm` MCP provider. */
export interface ServerSpec {
  readonly command: string;
  readonly args: string[];
}

export interface McpProviderHandle {
  /**
   * Notify VS Code that the provider's definitions changed, so it re-fetches
   * via `provideMcpServerDefinitions`. Safe to call unconditionally: it
   * no-ops when this host never had a live provider registered (see
   * feature-detection below), so callers never need to re-check capability
   * before calling this.
   */
  fireChanged(): void;
}

/**
 * Ambient shape for the one `vscode.lm` member this module needs, kept
 * separate from `@types/vscode`'s (non-optional) `lm` namespace declaration
 * so a host that omits `vscode.lm` entirely (any pre-~1.102 build, or a fork
 * such as Antigravity — curriculum 04 §5) narrows to `undefined` instead of
 * throwing on member access. Mirrors the technique in `fork-detect.ts`.
 */
interface OptionalLmNamespace {
  readonly lm?: {
    readonly registerMcpServerDefinitionProvider?: (
      id: string,
      provider: vscode.McpServerDefinitionProvider,
    ) => vscode.Disposable;
  };
}

function resolveRegisterFn(
  module: typeof vscode,
): ((id: string, provider: vscode.McpServerDefinitionProvider) => vscode.Disposable) | undefined {
  if (!('lm' in module)) return undefined;
  const registerFn = (module as unknown as OptionalLmNamespace).lm?.registerMcpServerDefinitionProvider;
  return typeof registerFn === 'function' ? registerFn : undefined;
}

/**
 * Register the `fortmesa` MCP server provider, or degrade to a clearly
 * logged no-op when the running host doesn't support the API.
 *
 * `getServerSpec` is called fresh on every `provideMcpServerDefinitions`
 * invocation. That's cheap and deliberate: the spec is static per
 * VSIX-PLAN.md §3.3 (a fixed `launch-mcp.sh`, no args), so there is nothing
 * to cache and no risk of ever serving a stale value — except the
 * `ideSync.vscode` on/off decision itself, which the caller re-evaluates
 * fresh from its own tracked config on every call too (see `extension.ts`).
 */
export function registerMcpProvider(
  context: vscode.ExtensionContext,
  getServerSpec: () => ServerSpec | undefined,
  log: Logger,
): McpProviderHandle {
  const registerFn = resolveRegisterFn(vscode);
  const changeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(changeEmitter);

  if (registerFn === undefined) {
    log.warn(
      'vscode.lm.registerMcpServerDefinitionProvider is not available on this host ' +
        '(requires VS Code ~1.102+; some forks, e.g. Antigravity, never implement it). ' +
        'Skipping live MCP registration for this host — the fortmesa server here must come ' +
        'from a file-based IDE projector instead (see src/registry/projectors).',
    );
    return {
      fireChanged(): void {
        // No provider is registered on this host — no-op rather than throw.
      },
    };
  }

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: () => {
      const spec = getServerSpec();
      if (spec === undefined) return [];
      return [new vscode.McpStdioServerDefinition('FortMesa', spec.command, spec.args)];
    },
  };

  const providerDisposable = registerFn('fortmesa.saferoom.mcpProvider', provider);
  context.subscriptions.push(providerDisposable);
  log.info('registered the fortmesa MCP server via vscode.lm.registerMcpServerDefinitionProvider');

  return {
    fireChanged(): void {
      changeEmitter.fire();
    },
  };
}
