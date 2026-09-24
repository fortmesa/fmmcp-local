#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { currentCredentialEnv, setCredentialProvider } from '../shared/api-client.js';
import { ScopeLock, resolveScopeLock } from '../shared/scope-lock.js';
import type { AuthorizedScope } from '../shared/scope-lock.js';
import { VERSION } from '../shared/version.js';
import { isExpiredCredentialError, resolveCredentials } from './auth/token-provider.js';
import { registerDocumentTools } from './tools/documents.js';
import type { GatewayRelay } from './tools/documents.js';
import { LocalToolRegistry } from './tools/registry.js';
import { connectGateway, startProxy } from './proxy.js';
import { createEventClient } from './event-client.js';
import { emitExpiredEvent, emitRefreshEvent } from './auth-events.js';
import type { ConnectedProxy } from './proxy.js';
import { loadConfig, resolveEffectiveStartup, saveConfig, watchConfig } from '../registry/config.js';
import { prodWarning, registerDataRegion } from '../registry/environments.js';
import type { Config, StartupFlags } from '../registry/config.js';
import { readCredentialsSummary, writeToken } from '../registry/credentials.js';
import { ENVIRONMENTS } from '../registry/environments.js';
import {
  LOOPBACK_PORTS,
  LoopbackStateMismatchError,
  loopbackRedirectUri,
  parsePastedCode,
  assertPastedState,
} from '../registry/oauth-flow.js';
import { resolveOAuthProvider, type OAuthProvider } from '../registry/oauth-provider.js';
import { loopbackLogin } from '../registry/login-flow.js';
import { buildAuthorizeUrl, exchangeCodeForToken, generatePkcePair } from '../registry/pkce.js';
import { listAndCacheScopes, resolveAndCacheScopeMap } from '../registry/scope-resolve.js';
import { summarizeSyncReport, syncAllTargets } from '../registry/sync.js';

/**
 * Entry point for the FortMesa Local MCP: the stdio proxy plus the
 * `fmmcp-local` management subcommands (VSIX-PLAN.md — CLI parity with the
 * Saferoom VSIX, D-V8: every config.json knob is reachable from here too).
 *
 * Default (no subcommand) — start the stdio proxy:
 *   fmmcp-local --env sandbox                                   # gateway http://localhost:3020/mcp
 *   fmmcp-local --env next --gateway https://mcp-next.dev.fort.blue/mcp
 *   fmmcp-local --env prod --scope-lock varmed-management       # scope-locked
 *
 * Flags always override ~/.fmcode/config.json (src/registry/config.ts's
 * resolveEffectiveStartup: flags > config.json > built-in defaults) at
 * startup. Once running, the proxy watches config.json and hot-reloads on
 * change — new env, gateway, or scope lock — without dropping the stdio pipe
 * to the agent; CLI flags are consulted only at initial startup, never
 * during a config-driven reload.
 *
 * Subcommands (same config.json/credentials.json as the Saferoom VSIX; none
 * of these start the proxy):
 *   fmmcp-local status                                   # config.json + effective startup + credential presence
 *   fmmcp-local switch --env <name>                      # set the active environment
 *   fmmcp-local switch --scope <name>[,<name>...]        # set scope lock (single, or "expert" multi if >1 name)
 *   fmmcp-local switch --unlock                          # explicit unlock (all scopes accessible)
 *   fmmcp-local token set <env> <token> [--base <url>]   # store a pasted token (creates the env if --base given)
 *   fmmcp-local scopes list [--env <name>]               # list scope name -> scopeId via the live gateway, caching it
 *   fmmcp-local sync                                     # project the fortmesa MCP server into detected, opted-in IDEs
 *   fmmcp-local login [--env <name>] [--no-browser]      # OAuth 2.0 code+PKCE sign-in (VSIX-PLAN.md §4.3; see the
 *                                                         # "login" subcommand doc comment for the current-status caveat)
 *
 * Credentials: FORTMESA_API_TOKEN (+ FORTMESA_API_BASE) env vars, falling back
 * to ~/.fmcode/credentials.json (block selected by --env, or config.json's
 * activeEnv when --env is absent). The bearer is attached to every gateway
 * request; the same credentials drive the LOCAL documents tools' direct API
 * calls.
 */

/** Log to stderr (stdout is reserved for JSON-RPC in stdio mode). */
function log(message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[fmmcp-local ${timestamp}] ${message}\n`);
}

/** Render a caught `unknown` (the type every `catch` binds under `strict`) as a log-safe string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A serialized-reload queue with a generation counter (F2): guarantees no two
 * config-driven reloads ever interleave, and that a rapid-fire burst of
 * config writes only ever actually runs the LAST one queued — any task still
 * waiting in the chain when a newer one is enqueued is skipped (logged, not
 * silently dropped) instead of racing the newer task's mutations.
 *
 * `watchConfig`'s own 150ms debounce only collapses bursts inside its window;
 * this queue is what protects a reload that is already `await`-suspended
 * (e.g. mid network round-trip) from a second config write landing before it
 * resolves and enqueuing a concurrent, interleaving reload.
 */
function createReloadQueue(logFn: (message: string) => void): (task: () => Promise<void>) => void {
  let generation = 0;
  let queueTail: Promise<void> = Promise.resolve();
  return (task: () => Promise<void>): void => {
    const myGeneration = ++generation;
    queueTail = queueTail.then(async () => {
      if (myGeneration !== generation) {
        logFn(
          `Reload: skipping a superseded config change (generation ${String(myGeneration)}, latest is ${String(generation)})`,
        );
        return;
      }
      await task();
    });
  };
}

/**
 * The repo root for this package: `package.json` sits two levels above the
 * compiled file (`dist/local-mcp/cli.js`), both in the repo checkout and in
 * any bundled/copied layout that preserves the `dist/` shape — same
 * derivation as `src/shared/version.ts` (curriculum 08-pitfalls-log.md #4),
 * just resolving to the containing directory instead of the `package.json`
 * file path itself, since that directory IS the repo root the `sync`
 * projectors need (`<repoRoot>/launch-mcp.sh`).
 *
 * Only reachable via the `sync` subcommand below — never at proxy startup.
 * That matters because `import.meta.url` does NOT survive esbuild's
 * `--format=cjs` (replaced with `{}`; see `extension.ts`'s
 * `resolveClientVersion` doc comment for the same landmine hit once
 * already). The Saferoom `.vsix` ships exactly such a bundle
 * (`dist-ext/cli.cjs`, `yarn build:cli`, UX-ROUND-2-PLAN.md W1) — but only
 * ever invokes it as the stdio proxy (`launch-mcp.sh --env <name>`), which
 * never calls `sync`, so this function is dead code in that bundle, not a
 * live landmine. Running `sync` against the bundled copy directly would
 * throw; the supported way to run CLI subcommands remains the repo checkout
 * (`dist/local-mcp/cli.js` via `yarn node`, unbundled, real `import.meta.url`).
 */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Parse --flag <value> from argv; undefined when absent. Throws on missing value. */
function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Split a comma-separated scope-name list into trimmed, non-empty names. */
function splitScopeNames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse --scope-lock <csv> into trimmed, non-empty scope names. */
function parseScopeLockArg(args: string[]): string[] {
  const raw = parseFlag(args, '--scope-lock');
  if (raw === undefined) return [];
  const names = splitScopeNames(raw);
  if (names.length === 0) {
    throw new Error('--scope-lock requires at least one non-empty scope name');
  }
  return names;
}

/**
 * Resolve `names` to a ScopeLock, trying the existing network-free path
 * first (`resolveScopeLock` against the cached scopeMap in
 * credentials.json — today's behavior, zero gateway round-trip) and falling
 * back to a live gateway lookup + scopeMap cache write
 * (`resolveAndCacheScopeMap`) only when a requested name is missing from
 * that cache.
 *
 * Returns the gateway `Client` it opened for the fallback path so a caller
 * that is about to make its OWN connection anyway (initial startup, which
 * hands this straight to `startProxy`) can reuse it instead of connecting
 * twice; `connectedClient` is `undefined` when the network-free path
 * succeeded. Callers that will NOT reuse the connection (the config-watch
 * reload handler below, whose `reload()` call opens its own) must close it.
 */
async function resolveLock(
  names: string[],
  locked: boolean,
  env: string,
  scopeMap: Record<string, string> | undefined,
  gatewayUrl: URL,
  bearerToken: string,
): Promise<{ lock: ScopeLock; authorizedScopes: AuthorizedScope[]; connectedClient?: Client }> {
  const context = { env, ...(scopeMap !== undefined ? { knownScopes: scopeMap } : {}) };

  if (!locked) {
    return { lock: ScopeLock.unlocked(), authorizedScopes: [] };
  }

  // Locked with nothing selected: FAIL CLOSED. Reachable whenever
  // scopeLock.mode is single/multi while scopes is empty — the two are
  // independent settings. This used to build an unlocked lock, so the proxy
  // permitted every scope while the sidebar read "single (no scopes
  // selected)". One click in the sidebar recovers it, so refusing everything
  // is proportionate; refusing to START would instead take the whole MCP
  // server down over a one-click state.
  if (names.length === 0) {
    return { lock: ScopeLock.lockedTo([], context), authorizedScopes: [] };
  }

  try {
    const authorizedScopes = resolveScopeLock(names, scopeMap, env);
    return { lock: ScopeLock.lockedTo(authorizedScopes, context), authorizedScopes };
  } catch {
    // A name is missing from the cached scopeMap (or there is no scopeMap
    // yet) — fall through to live resolution below.
    log(`Scope name(s) not resolvable from the cached scopeMap for env "${env}" — resolving via the live gateway.`);
  }

  const connectedClient = await connectGateway(gatewayUrl, bearerToken, VERSION);
  const authorizedScopes = await resolveAndCacheScopeMap(names, env, connectedClient);
  return { lock: ScopeLock.lockedTo(authorizedScopes, context), authorizedScopes, connectedClient };
}

/**
 * Config-driven hot-reload handler (VSIX-PLAN §4.3 / D-V10): invoked by
 * `watchConfig()` whenever config.json changes while the proxy is running.
 * Re-resolves env/gateway/credentials/scope-lock from the NEW config with NO
 * flag overrides — CLI flags apply only at startup (`runProxy` below); once
 * running, config.json alone drives reloads.
 */
async function handleConfigChange(newConfig: Config, proxy: ConnectedProxy): Promise<void> {
  const effective = resolveEffectiveStartup({}, newConfig, log);
  const gatewayUrl = new URL(effective.gatewayUrl);
  log(
    `config.json changed — reloading (env: ${effective.env}, gateway: ${effective.gatewayUrl}, ` +
      `scope-lock: [${effective.scopeLockNames.join(', ')}])`,
  );

  const creds = await resolveCredentials(effective.env);
  const { lock, authorizedScopes, connectedClient } = await resolveLock(
    effective.scopeLockNames,
    effective.scopeLocked,
    effective.env,
    creds.scopeMap,
    gatewayUrl,
    creds.token,
  );

  // Unlike runProxy's initial connection, this handler's own gateway
  // connection (if the fallback path opened one) is not reused — reload()
  // below always opens its own — so close it here to avoid leaking it.
  if (connectedClient !== undefined) {
    await connectedClient.close();
  }

  await proxy.reload({
    gatewayUrl,
    // Carried so an installed credential provider follows the env switch
    // instead of continuing to resolve the environment we just left.
    env: effective.env,
    bearerToken: creds.token,
    apiBaseUrl: creds.baseUrl,
    lock,
    disabledTools: newConfig.disabledTools,
    documentsMode: newConfig.documentsMode,
  });

  if (authorizedScopes.length > 0) {
    const summary = authorizedScopes.map((s) => `${s.scopeId} (${s.name})`).join(', ');
    log(
      `Reload complete: env=${effective.env}, scope lock active: ${String(authorizedScopes.length)} scope(s) [${summary}]`,
    );
  } else if (effective.scopeLocked) {
    log(`Reload complete: env=${effective.env}, scope lock active with NO scope selected — every scope is refused`);
  } else {
    log(`Reload complete: env=${effective.env}, scope lock disabled (all scopes accessible)`);
  }
}

/** Default (no-subcommand) path: resolve startup config and start the proxy. */
async function runProxy(args: string[]): Promise<void> {
  const envFlag = parseFlag(args, '--env');
  const gatewayFlag = parseFlag(args, '--gateway');
  const scopeLockFlagPresent = args.includes('--scope-lock');
  const scopeLockNamesFlag = scopeLockFlagPresent ? parseScopeLockArg(args) : undefined;

  // A data region override (the MCPB's single user_config field) REPLACES the
  // environment rather than patching an API base onto production's: gateway,
  // API base, OAuth identity and the credentials key all have to move together
  // or they describe two different places at once. See
  // `registry/environments.ts#deriveDataRegion` for why a bare base URL cannot
  // do this. An explicit --gateway still wins; nothing else does.
  const dataRegion = process.env.FORTMESA_DATA_REGION?.trim();
  let regionFlags: StartupFlags = {};
  // A rejected override must NOT fall back to production — the user named
  // somewhere else. Serve stdio and refuse every call with the reason instead
  // (same mechanism as the pending sign-in below), so the host shows a
  // connected server that can explain itself rather than one that just died.
  let regionError: string | undefined;
  if (dataRegion !== undefined && dataRegion !== '') {
    try {
      const region = registerDataRegion(dataRegion);
      log(`Data region: ${region.entry.label} — env "${region.name}", gateway ${region.entry.gateway}`);
      regionFlags = { env: region.name, ...(gatewayFlag === undefined ? { gateway: region.entry.gateway } : {}) };
    } catch (error) {
      regionError = `FortMesa is not configured: ${errorMessage(error)}`;
      log(regionError);
    }
  }

  const flags: StartupFlags = {
    ...(envFlag !== undefined ? { env: envFlag } : {}),
    ...(gatewayFlag !== undefined ? { gateway: gatewayFlag } : {}),
    ...(scopeLockNamesFlag !== undefined ? { scopeLockNames: scopeLockNamesFlag } : {}),
    ...regionFlags,
  };

  const loadedConfig = await loadConfig();
  const effective = resolveEffectiveStartup(flags, loadedConfig, log);
  // F2 (2026-09-04 blank-persona test): prod is the default and nothing said so.
  // Warn on every startup — including the extension's, which launches this same
  // entrypoint through launch-mcp.sh. Warning only; the default is unchanged.
  const prodNotice = prodWarning(effective.env);
  if (prodNotice !== undefined) log(prodNotice);
  const gatewayUrl = new URL(effective.gatewayUrl);

  // ── Event viewer wire (best effort) ─────────────────────────
  // Connects to the Saferoom extension host's sink if one is listening on
  // this machine; drops every record on the floor if not, which is the normal
  // case for a proxy launched by a headless agent. Never blocks, never
  // throws, never holds the process open — see `event-client.ts`.
  //
  // Opened BEFORE credentials are resolved, not after: token refresh and
  // token expiry are auth events the pane must show, and both happen inside
  // `resolveCredentials` below. A client created after them would be
  // structurally unable to report the two auth outcomes a user can act on.
  const events = createEventClient();

  // ── Credentials (env → file chain) ──────────────────────────
  // An expiring token is renewed in here rather than rejected; `onRefresh`
  // only surfaces what happened.
  const resolve = async () =>
    resolveCredentials(effective.env, {
      onRefresh: (outcome) => {
        emitRefreshEvent(events, outcome);
        if (outcome.reason === 'refreshed') log(`Access token refreshed for env "${effective.env}".`);
        else if (outcome.reason === 'raced') log(`Another process refreshed env "${effective.env}"; using its token.`);
        else if (outcome.reason === 'failed')
          log(`Token refresh failed for env "${effective.env}": ${outcome.error ?? 'unknown'}`);
      },
    });

  // `undefined` means: no credentials yet, and a background sign-in is about
  // to run. See SIGN_IN_PENDING and ProxyOptions.pendingReason — the server
  // MUST reach `mcp.connect(stdio)` promptly, because the host that spawned it
  // is already waiting on `initialize`, and a browser sign-in takes as long as
  // a human takes. Awaiting the sign-in here is what made a default Claude
  // Desktop install report "Unable to connect to extension server".
  let creds: Awaited<ReturnType<typeof resolve>> | undefined;
  let signInPending = false;
  if (regionError === undefined) {
    try {
      creds = await resolve();
      log(`Credentials resolved (env: ${effective.env}, source: ${creds.source}, base: ${creds.baseUrl})`);
    } catch (error) {
      // A bundled server has no terminal and no Saferoom UI, so browser sign-in
      // is its only way to obtain credentials. Off unless FMCODE_AUTO_LOGIN says
      // otherwise, and the original error is rethrown when sign-in is
      // unavailable, so no caller loses the real reason.
      if (!autoLoginAvailable(effective.env)) throw error;
      signInPending = true;
      log(`No stored credentials for env "${effective.env}" — serving stdio now and signing in in the background.`);
    }
  }
  const pendingReason = regionError ?? (signInPending ? SIGN_IN_PENDING : undefined);

  // A provider, not a captured token. The proxy outlives its credentials: a
  // token good at boot expires later, and a `login` run while this process is
  // up rewrites credentials.json underneath it. Resolving per request means
  // the expiry gate and the refresh in resolveCredentials actually run, rather
  // than firing once at startup and never again.
  setCredentialProvider(async () => {
    const env = currentCredentialEnv(effective.env);
    let current;
    try {
      current = await resolveCredentials(env, {
        onRefresh: (outcome) => {
          emitRefreshEvent(events, outcome);
          if (outcome.reason === 'refreshed') log(`Access token refreshed for env "${env}".`);
          else if (outcome.reason === 'raced') log(`Another process refreshed env "${env}"; using its token.`);
          else if (outcome.reason === 'failed')
            log(`Token refresh failed for env "${env}": ${outcome.error ?? 'unknown'}`);
        },
      });
    } catch (error: unknown) {
      // Only the expiry refusal becomes a timeline row. "No credentials at
      // all" and "the file is malformed" are configuration faults, not
      // session events, and the pane is not a place to debug them.
      if (isExpiredCredentialError(error)) emitExpiredEvent(events);
      throw error;
    }
    return { token: current.token, baseUrl: current.baseUrl };
  });

  // ── Scope lock ──────────────────────────────────────────────
  // Try the network-free path first (resolveScopeLock against the cached
  // scopeMap in credentials.json — today's behavior, no extra round-trip).
  // Only when a requested name is missing from that cache do we pay for a
  // live gateway connection to resolve + cache it; that same connection is
  // then handed straight to startProxy below instead of connecting twice.
  //
  // With no credentials yet there is nothing to resolve names against and no
  // token to resolve them WITH, so a configured lock starts fail-closed (the
  // same state `resolveLock` produces for "locked, nothing selected") and the
  // post-sign-in reload below resolves it for real.
  const { lock, authorizedScopes, connectedClient } =
    creds === undefined
      ? {
          lock: effective.scopeLocked ? ScopeLock.lockedTo([], { env: effective.env }) : ScopeLock.unlocked(),
          authorizedScopes: [] as AuthorizedScope[],
          connectedClient: undefined,
        }
      : await resolveLock(
          effective.scopeLockNames,
          effective.scopeLocked,
          effective.env,
          creds.scopeMap,
          gatewayUrl,
          creds.token,
        );
  if (authorizedScopes.length > 0) {
    const summary = authorizedScopes.map((s) => `${s.scopeId} (${s.name})`).join(', ');
    log(`Scope lock active: ${String(authorizedScopes.length)} scope(s) authorized [${summary}]`);
  } else if (effective.scopeLocked) {
    log('Scope lock: ACTIVE with no scope selected — every scope is refused until one is selected');
  } else {
    log('Scope lock: disabled (all scopes accessible)');
  }

  // ── Local tools (documents — path-based file I/O) ───────────
  const registry = new LocalToolRegistry();

  // ── Proxy: gateway client + stdio server ────────────────────
  const connectedProxy = await startProxy({
    events,
    gatewayUrl,
    bearerToken: creds?.token ?? '',
    ...(pendingReason !== undefined ? { pendingReason } : {}),
    registry,
    lock,
    disabledTools: loadedConfig.disabledTools,
    documentsMode: loadedConfig.documentsMode,
    log,
    clientVersion: VERSION,
    ...(connectedClient !== undefined ? { gatewayClient: connectedClient } : {}),
  });

  // Registered AFTER startProxy resolves (no intervening await) so the
  // documents tools' scope-lock check always reads the LIVE lock via
  // connectedProxy.getLock() instead of the stale startup value (F3).
  registerDocumentTools(
    registry,
    () => connectedProxy.getLock(),
    // Read the client through the getter, not by closure: reload() swaps it.
    async (toolName, args) => {
      // Not reachable in practice: tools/call refuses every tool, local ones
      // included, until the gateway is connected. Stated rather than asserted,
      // because the alternative is a null-dereference at the far end of a relay.
      const client = connectedProxy.getGatewayClient();
      if (client === undefined) {
        throw new Error(`'${toolName}' needs the FortMesa gateway, which is not connected yet.`);
      }
      return (await client.callTool({ name: toolName, arguments: args })) as unknown as Awaited<
        ReturnType<GatewayRelay>
      >;
    },
  );
  log(
    `Local tools registered: [${registry.names().join(', ')}]; everything else proxied to the gateway. ` +
      `Documents mode: ${loadedConfig.documentsMode}` +
      (loadedConfig.documentsMode === 'network'
        ? " — the local grc_documents_* tools are withheld and the gateway's URL-based ones pass through."
        : " — the gateway's document tools are advertised with local download/upload added."),
  );

  // ── Background sign-in (MCPB / FMCODE_AUTO_LOGIN) ───────────
  // Runs only when startup found no credentials. Deliberately NOT awaited:
  // the stdio transport is connected above and the host's `initialize` has
  // already been answered, so this can take the minutes a human takes. When
  // it lands, reload() attaches the gateway and sends tools/list_changed; the
  // agent re-reads tools/list and the FortMesa tools appear.
  if (signInPending) {
    void (async () => {
      try {
        if (!(await autoLoginIfEnabled(effective.env))) {
          log(`Sign-in did not complete for env "${effective.env}" — FortMesa tools stay unavailable this session.`);
          return;
        }
        const signedIn = await resolve();
        log(`Credentials resolved (env: ${effective.env}, source: ${signedIn.source}, base: ${signedIn.baseUrl})`);
        const resolved = await resolveLock(
          effective.scopeLockNames,
          effective.scopeLocked,
          effective.env,
          signedIn.scopeMap,
          gatewayUrl,
          signedIn.token,
        );
        // reload() opens its own gateway connection, so this one is ours to close.
        if (resolved.connectedClient !== undefined) await resolved.connectedClient.close();
        await connectedProxy.reload({
          gatewayUrl,
          env: effective.env,
          bearerToken: signedIn.token,
          apiBaseUrl: signedIn.baseUrl,
          lock: resolved.lock,
          disabledTools: loadedConfig.disabledTools,
          documentsMode: loadedConfig.documentsMode,
        });
        log('Sign-in complete — gateway connected and the full tool list is now advertised.');
      } catch (error) {
        // Nothing above may reject into the void: an unhandled rejection kills
        // the process, and the process IS the user's MCP server.
        log(`Background sign-in failed: ${errorMessage(error)}`);
      }
    })();
  }

  // ── Config-driven hot-reload (VSIX-PLAN §4.3 / D-V10) ───────
  // Once the proxy is running, live edits to config.json — from this CLI's
  // own `switch`/`token` subcommands, the Saferoom VSIX, or a human editor —
  // are what drive reloads; flags are consulted only at the startup above.
  //
  // F2: route every config change through the serialized reload queue rather
  // than firing-and-forgetting handleConfigChange directly — otherwise a
  // config write landing while a previous reload is still await-suspended
  // would spawn a second, concurrent reload racing the same bindings.
  const enqueueReload = createReloadQueue(log);
  const configWatcher = watchConfig((newConfig) => {
    enqueueReload(() =>
      handleConfigChange(newConfig, connectedProxy).catch((error: unknown) => {
        // The proxy has already quarantined itself (proxy.ts reload()), so the
        // agent now gets an explicit refusal on every call instead of silently
        // continuing on the environment/scope the user just moved away from.
        // Say so here too — a bare "reload failed" line reads as cosmetic and
        // was the reason this failure went unnoticed.
        const detail = error instanceof Error ? error.message : String(error);
        const state = connectedProxy.isQuarantined()
          ? 'the proxy is QUARANTINED and is refusing all tool calls until a reload succeeds'
          : 'the proxy was NOT quarantined — it is still serving the previous environment and scope';
        log(`Config-driven reload FAILED: ${detail} — ${state}. Re-apply the change in the Saferoom sidebar to retry.`);
      }),
    );
  }, log);

  // ── Shutdown on stdio-pipe close ─────────────────────────────
  // An MCP client detaches a stdio server by closing its end of the pipe, not
  // by sending a process signal first — the SDK's own StdioClientTransport
  // does exactly that (closes stdin, THEN grace-waits ~2s before escalating
  // to SIGTERM, then SIGKILL). `StdioServerTransport` never reacts to stdin
  // ending on its own, and this proxy's upstream gateway connection holds an
  // indefinitely long-lived SSE stream open (StreamableHTTPClientTransport's
  // GET listener for server-initiated messages) — that alone keeps the event
  // loop, and therefore this whole process, alive forever regardless of
  // stdin. So "wait for the loop to drain naturally" never happens on its
  // own; tear down explicitly on EOF instead: close the config watcher
  // (clearing any in-flight debounce timer) and the proxy (which closes the
  // stdio transport AND aborts the gateway's SSE connection —
  // `ConnectedProxy.close()`). Once both are closed there is nothing left
  // holding the event loop open, so the process exits on its own — no
  // `process.exit()` needed (n/no-process-exit; it would also risk cutting
  // off any not-yet-flushed stdout write). `readableEnded` covers the
  // (unlikely but possible) case where stdin already hit EOF before this
  // listener was attached, since a "once ended" event is not re-emitted for a
  // late listener.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('stdio pipe closed — shutting down');
    configWatcher.close();
    void connectedProxy.close().catch((error: unknown) => {
      log(`Error while closing the proxy during shutdown: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  if (process.stdin.readableEnded) {
    shutdown();
  } else {
    process.stdin.once('end', shutdown);
  }
}

// ── Shared credentials.json helpers (token set / status) ────
//
// Extracted into src/registry/credentials.ts (writeToken, readCredentialsSummary,
// decodeJwtExpiry, clearToken, readCurrentToken) so this CLI
// and the Saferoom VSIX's auth commands share exactly one read/write path for
// ~/.fmcode/credentials.json — see that module's doc comment for the
// one-way-dependency rationale (registry never imports local-mcp/vscode).

// ── Subcommands ────────────────────────────────────────────────────────

/** `fmmcp-local status` — config.json, effective startup, credential presence. Human stdout, not JSON-RPC. */
async function runStatus(): Promise<void> {
  const loadedConfig = await loadConfig();
  process.stdout.write(`${JSON.stringify(loadedConfig, null, 2)}\n\n`);

  const effective = resolveEffectiveStartup({}, loadedConfig, log);
  const scopeDisplay = effective.scopeLockNames.length > 0 ? effective.scopeLockNames.join(', ') : '(unlocked)';
  process.stdout.write(
    `Effective startup:\n` +
      `  env:        ${effective.env}\n` +
      `  gateway:    ${effective.gatewayUrl}\n` +
      `  scope-lock: ${scopeDisplay}\n\n`,
  );

  const prodNotice = prodWarning(effective.env);
  if (prodNotice !== undefined) {
    process.stdout.write(`${prodNotice}\n\n`);
  }

  const summary = await readCredentialsSummary(effective.env);
  if (!summary.hasToken) {
    process.stdout.write(`Credentials: no token found for env "${effective.env}" in credentials.json\n`);
  } else {
    const expiresAt = summary.expiresAt ?? 'unknown';
    const state = summary.expired === true ? ' [EXPIRED — sign in again]' : '';
    process.stdout.write(`Credentials: token present for env "${effective.env}" (expires_at: ${expiresAt})${state}\n`);
  }
}

async function switchEnv(envName: string): Promise<void> {
  const loadedConfig = await loadConfig();
  if (!(envName in loadedConfig.environments)) {
    const known = Object.keys(loadedConfig.environments).join(', ');
    throw new Error(`Unknown environment "${envName}". Known environments: [${known}]`);
  }
  const nextConfig: Config = { ...loadedConfig, activeEnv: envName };
  await saveConfig(nextConfig);
  process.stdout.write(
    `Switched active environment to "${envName}" — running proxies apply it on their next reload; ` +
      'verify with `fmmcp-local status`.\n',
  );
}

async function switchScope(scopeArg: string): Promise<void> {
  const names = splitScopeNames(scopeArg);
  if (names.length === 0) {
    throw new Error('--scope requires at least one non-empty scope name');
  }
  const loadedConfig = await loadConfig();
  const nextConfig: Config = {
    ...loadedConfig,
    scopeLock: { mode: names.length > 1 ? 'multi' : 'single', scopes: names },
  };
  await saveConfig(nextConfig);
  process.stdout.write(
    `Scope lock set to ${nextConfig.scopeLock.mode}: [${names.join(', ')}] — running proxies apply it on their ` +
      'next reload; verify with `fmmcp-local status`.\n',
  );
}

async function switchUnlock(): Promise<void> {
  const loadedConfig = await loadConfig();
  const nextConfig: Config = { ...loadedConfig, scopeLock: { mode: 'unlocked', scopes: [] } };
  await saveConfig(nextConfig);
  process.stdout.write(
    'Scope lock disabled (unlocked — all scopes accessible) — running proxies apply it on their next reload; ' +
      'verify with `fmmcp-local status`.\n',
  );
}

/** `fmmcp-local switch --env|--scope|--unlock` — mutates config.json only; the running proxy picks it up via watchConfig. */
async function runSwitch(rest: string[]): Promise<void> {
  const envName = parseFlag(rest, '--env');
  const scopeArg = parseFlag(rest, '--scope');
  const unlockRequested = rest.includes('--unlock');

  if (envName !== undefined) {
    await switchEnv(envName);
    return;
  }
  if (scopeArg !== undefined) {
    await switchScope(scopeArg);
    return;
  }
  if (unlockRequested) {
    await switchUnlock();
    return;
  }
  throw new Error('Usage: fmmcp-local switch --env <name> | --scope <name>[,<name>...] | --unlock');
}

/** `fmmcp-local token set <env> <token> [--base <url>]`. */
async function runTokenSet(rest: string[]): Promise<void> {
  const base = parseFlag(rest, '--base');
  const env = rest[0];
  const token = rest[1];
  if (env === undefined || token === undefined || env.startsWith('--') || token.startsWith('--')) {
    throw new Error('Usage: fmmcp-local token set <env> <token> [--base <url>]');
  }

  await writeToken(env, token, base);
  process.stdout.write(`Token set for env "${env}".\n`);
}

async function runToken(rest: string[]): Promise<void> {
  const action = rest[0];
  if (action === 'set') {
    await runTokenSet(rest.slice(1));
    return;
  }
  throw new Error(`Unknown "token" action "${action ?? ''}". Expected "set".`);
}

/** `fmmcp-local scopes list [--env <name>]` — live gateway lookup, printed and cached into credentials.json's scopeMap (shared with the Saferoom scope switchers via registry/scope-resolve.ts's listAndCacheScopes). */
async function runScopesList(rest: string[]): Promise<void> {
  const envFlag = parseFlag(rest, '--env');
  const loadedConfig = await loadConfig();
  const flags: StartupFlags = envFlag !== undefined ? { env: envFlag } : {};
  const effective = resolveEffectiveStartup(flags, loadedConfig, log);
  const gatewayUrl = new URL(effective.gatewayUrl);

  const creds = await resolveCredentials(effective.env);
  const client = await connectGateway(gatewayUrl, creds.token, VERSION);

  try {
    const entries = await listAndCacheScopes(effective.env, client);
    for (const entry of entries) {
      process.stdout.write(`${entry.id}  ${entry.name}\n`);
    }
  } finally {
    await client.close();
  }
}

async function runScopes(rest: string[]): Promise<void> {
  const action = rest[0];
  if (action !== 'list') {
    throw new Error(`Unknown "scopes" action "${action ?? ''}". Expected "list".`);
  }
  await runScopesList(rest.slice(1));
}

/**
 * `fmmcp-local sync` — project the canonical `fortmesa` MCP server entry into
 * every detected, opted-in IDE target (VSIX-PLAN.md §3.3). Prints the same
 * human-readable report the Saferoom extension will later render, and exits
 * non-zero if any target's projection failed outright (a `skipped`/not-
 * detected target is not a failure).
 */
async function runSync(): Promise<void> {
  try {
    const config = await loadConfig();
    const results = await syncAllTargets(config, packageRoot(), log);
    process.stdout.write(`${summarizeSyncReport(results)}\n`);
    process.exitCode = results.some((result) => result.action === 'error') ? 1 : 0;
  } catch (error: unknown) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// ── OAuth 2.0 code+PKCE login (VSIX-PLAN.md §4.3, as amended 2026-07-05) ──
//
// Remote browser-callback OAuth is post-prototype backlog #6 — the two
// supported transport paths are the LOCAL loopback callback (`oauth-flow.ts`'s
// `runLocalLoopbackFlow`) and paste-code (print the authorize URL, read the
// resulting code/redirect URL back from stdin). This CLI picks between them
// with the same heuristic the extension uses `vscode.env.remoteName` for —
// there being no such signal available to a plain CLI process, `--no-browser`
// or an SSH-shell environment (`SSH_CONNECTION`/`SSH_TTY`) stands in for it.

// `src/registry/oauth-provider.ts` resolves the CIMD OAuth provider
// (issuer, client identity, resource, scope) per login from the env's API base.

/**
 * Resolve the API base URL for the OAuth flow, in precedence order:
 * existing credentials.json entry, then the built-in default for a KNOWN
 * environment (`environments.ts`), then a stdin prompt. A built-in env must
 * never ask the user to type a URL the CLI already ships — the prompt is
 * only for an environment it has never heard of.
 */
async function resolveApiBaseForLogin(env: string): Promise<string> {
  try {
    // allowExpired: this reads baseUrl only, and it runs on the way INTO a
    // fresh sign-in. Refusing here because the stored token is dead would
    // discard the very API base the new login needs.
    const creds = await resolveCredentials(env, { allowExpired: true });
    return creds.baseUrl;
  } catch {
    // No credentials yet — fall through.
  }

  const known = ENVIRONMENTS[env]?.api;
  if (known !== undefined && known !== '') return known;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`"${env}" is not a built-in environment — enter its API base URL: `)).trim();
    if (answer === '') {
      throw new Error(`An API base URL is required to sign in to environment "${env}".`);
    }
    return answer;
  } finally {
    rl.close();
  }
}

/** Prompt on stdin for the pasted authorization code or full redirect URL, verify its `state` against `expectedState`, and return the extracted code (`oauth-flow.ts#parsePastedCode`). */
async function promptForPastedCode(expectedState: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Paste the full redirect URL from your browser (or "code#state"): ');
    const parsed = parsePastedCode(answer);
    // F-4: same hard stop the loopback path enforces. Round 2 goes further —
    // a BARE code is refused outright, so there is no paste shape left whose
    // state cannot be checked.
    assertPastedState(parsed, expectedState);
    return parsed.code;
  } finally {
    rl.close();
  }
}

/**
 * The paste-code transport path (VSIX-PLAN.md §4.3): print the authorize URL
 * (built for `LOOPBACK_PORTS[0]`'s redirect_uri — nothing needs to actually
 * be listening there, since the user copies the code, or the whole
 * failed-to-load redirect URL, out of their browser's address bar instead of
 * the callback being fetched programmatically) and read the result back.
 */
async function runPasteCodeLogin(
  provider: OAuthProvider,
  codeChallenge: string,
  state: string,
): Promise<{ code: string; redirectUri: string }> {
  const redirectUri = loopbackRedirectUri(LOOPBACK_PORTS[0]);
  const url = buildAuthorizeUrl(provider.issuerBase, {
    clientId: provider.clientId,
    redirectUri,
    codeChallenge,
    state,
    resource: provider.resource,
    scope: provider.scope,
  });
  process.stdout.write(
    `Open this URL in a browser to sign in:\n\n  ${url}\n\n` +
      'After you approve, the browser will try to redirect to a page that is not actually running — that is ' +
      'expected. Copy the FULL url from the address bar and paste it below — the whole address, not just the code ' +
      '(the "state" value in it is what proves the code belongs to THIS sign-in).\n\n',
  );
  const code = await promptForPastedCode(state);
  return { code, redirectUri };
}

/** `fmmcp-local login [--env <name>] [--no-browser]` — VSIX-PLAN.md §4.3. */
async function runLogin(rest: string[]): Promise<void> {
  const envFlag = parseFlag(rest, '--env');
  const noBrowser = rest.includes('--no-browser');

  const loadedConfig = await loadConfig();
  const env = envFlag ?? loadedConfig.activeEnv;
  if (!(env in loadedConfig.environments)) {
    const known = Object.keys(loadedConfig.environments).join(', ');
    throw new Error(`Unknown environment "${env}". Known environments: [${known}]`);
  }

  const apiBase = await resolveApiBaseForLogin(env);
  const provider = resolveOAuthProvider(env, apiBase);
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(16).toString('hex');

  const remoteShell = process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined;
  const usePasteCode = noBrowser || remoteShell;

  let code: string;
  let redirectUri: string;

  if (usePasteCode) {
    log(
      `Using the paste-code sign-in path for env "${env}" (${noBrowser ? '--no-browser' : 'remote-shell heuristic'}).`,
    );
    ({ code, redirectUri } = await runPasteCodeLogin(provider, challenge, state));
  } else {
    try {
      // Shared with the proxy's first-run sign-in (`registry/login-flow.ts`).
      // Here `notify` goes to stdout because a terminal user is reading it; in
      // the proxy it MUST go to stderr.
      await loopbackLogin(provider, env, apiBase, {
        notify: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`Signed in for env "${env}".\n`);
      return;
    } catch (error) {
      if (error instanceof LoopbackStateMismatchError) {
        // Security-relevant (possible tampering/replay) — never silently
        // fall back to paste-code for this one; surface it as a hard stop.
        throw error;
      }
      log(`Local loopback OAuth listener unavailable (${errorMessage(error)}) — falling back to the paste-code path.`);
      ({ code, redirectUri } = await runPasteCodeLogin(provider, challenge, state));
    }
  }

  const tokenResponse = await exchangeCodeForToken(provider.issuerBase, {
    clientId: provider.clientId,
    redirectUri,
    code,
    codeVerifier: verifier,
    resource: provider.resource,
  });

  await writeToken(env, tokenResponse.access_token, apiBase, tokenResponse.refresh_token);
  process.stdout.write(`Signed in for env "${env}".\n`);
}

/**
 * First-run sign-in for a bundled server (`.mcpb`), where there is no terminal
 * and no Saferoom UI to sign in from.
 *
 * Opt-in through FMCODE_AUTO_LOGIN, which the MCP Bundle manifest sets. A
 * proxy started from a shell or an IDE must never pop a browser on its own,
 * so the default stays off.
 *
 * The paste-code fallback is deliberately unavailable here: it reads stdin,
 * and stdin is the client's half of the JSON-RPC stream. Everything this
 * prints goes to stderr for the same reason.
 */
function autoLoginAvailable(env: string): boolean {
  if (process.env.FMCODE_AUTO_LOGIN !== 'true') return false;

  const clientId = ENVIRONMENTS[env]?.clientId;
  if (clientId === undefined) {
    log(`No OAuth sign-in for env "${env}" — supply FORTMESA_API_TOKEN instead.`);
    return false;
  }
  return true;
}

/**
 * The message a gateway tool call gets while the background sign-in is still
 * running. Written for an AGENT to relay: an MCPB user never sees stderr.
 */
const SIGN_IN_PENDING =
  'FortMesa sign-in has not finished yet. A browser window was opened to sign you in to FortMesa; ' +
  'complete it and the FortMesa tools will appear (the server sends a tools/list_changed when they do). ' +
  "If no window opened, the sign-in URL is in this MCP server's log.";

async function autoLoginIfEnabled(env: string): Promise<boolean> {
  if (!autoLoginAvailable(env)) return false;

  const apiBase = await resolveApiBaseForLogin(env);
  const provider = resolveOAuthProvider(env, apiBase);

  log(`No stored credentials for env "${env}". Starting browser sign-in.`);
  try {
    // FMCODE_LOGIN_TIMEOUT_MS exists so the .mcpb build's smoke test can
    // exercise this path in seconds rather than waiting out the real window.
    const timeoutRaw = Number(process.env.FMCODE_LOGIN_TIMEOUT_MS);
    const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? { timeoutMs: timeoutRaw } : {};
    await loopbackLogin(provider, env, apiBase, { notify: log, launchBrowser: true, ...timeout });
  } catch (error) {
    log(`Sign-in failed: ${errorMessage(error)}`);
    return false;
  }

  log(`Signed in for env "${env}".`);
  return true;
}

const KNOWN_SUBCOMMANDS = ['status', 'switch', 'token', 'scopes', 'sync', 'login'] as const;

const USAGE = `fmmcp-local — FortMesa Local MCP proxy + management CLI

Usage:
  fmmcp-local [--env <name>] [--gateway <url>] [--scope-lock <name>[,<name>...]]
                                                        # start the stdio proxy (default, flags-only)
  fmmcp-local status                                   # config.json + effective startup + credential presence
  fmmcp-local switch --env <name>                      # set the active environment
  fmmcp-local switch --scope <name>[,<name>...]        # set scope lock
  fmmcp-local switch --unlock                          # explicit unlock (all scopes accessible)
  fmmcp-local token set <env> <token> [--base <url>]   # store a pasted token
  fmmcp-local scopes list [--env <name>]               # list scope name -> scopeId via the live gateway
  fmmcp-local sync                                     # project the fortmesa MCP server into detected IDEs
  fmmcp-local login [--env <name>] [--no-browser]      # OAuth 2.0 code+PKCE sign-in
  fmmcp-local --help | -h                              # show this message

ENVIRONMENT: the default environment is "prod" — FortMesa PRODUCTION, with live customer data.
Every run prints the resolved environment on stderr. Use --env <name> for a single run, or
\`fmmcp-local switch --env <name>\` to change the stored default. \`fmmcp-local status\` shows
which environment and gateway are in effect before you start.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  // --help/-h is checked before subcommand dispatch so it works regardless
  // of position/other flags being present.
  if (subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  // F7: an unrecognized POSITIONAL subcommand must never silently fall
  // through to runProxy (e.g. "fmmcp-local statuss" booting a stdio proxy
  // instead of erroring). The proxy boots only on flags-only invocations —
  // zero positional args at all, or a leading arg that is itself a flag
  // (e.g. "--env sandbox"). Anything else that isn't one of the known
  // subcommands is a typo: print usage to stderr and exit non-zero.
  if (
    subcommand !== undefined &&
    !subcommand.startsWith('--') &&
    !(KNOWN_SUBCOMMANDS as readonly string[]).includes(subcommand)
  ) {
    process.stderr.write(`Unknown subcommand "${subcommand}".\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  // Dispatched with if/else (not switch) because `subcommand` is
  // `string | undefined` — an open-ended type, not a finite union/enum —
  // which trips this repo's `switch-exhaustiveness-check` lint rule.
  if (subcommand === 'status') {
    await runStatus();
  } else if (subcommand === 'switch') {
    await runSwitch(argv.slice(1));
  } else if (subcommand === 'token') {
    await runToken(argv.slice(1));
  } else if (subcommand === 'scopes') {
    await runScopes(argv.slice(1));
  } else if (subcommand === 'sync') {
    await runSync();
  } else if (subcommand === 'login') {
    await runLogin(argv.slice(1));
  } else {
    await runProxy(argv);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[fmmcp-local FATAL] ${message}\n`);
  process.exitCode = 1;
});
