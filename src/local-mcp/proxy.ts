import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { toolError } from '../shared/tool-helpers.js';
import { onCredentialEnvChange, setApiCredentials } from '../shared/api-client.js';
import type { ScopeLock } from '../shared/scope-lock.js';
import { ReloadState } from './reload-state.js';
import { ToolSchemaCache } from './tool-schema-cache.js';
import { dispatchesLocally, mergeToolLists, type DocumentsMode } from '../registry/documents-mode.js';
import { NO_TOOL_CONTEXT, type ToolContext } from './tools/registry.js';
import type { LocalToolRegistry } from './tools/registry.js';

/**
 * The Local MCP proxy ("the dumb proxy", SPECS §2/§4):
 *
 *   IDE agent ↔ [stdio] ↔ this proxy ↔ [streamable HTTP + bearer] ↔ Cloud gateway
 *
 * - Gateway tools are relayed with their JSON Schemas verbatim — this side owns
 *   ZERO gateway schemas. That requires the low-level `Server` (McpServer's
 *   registerTool only accepts Zod shapes).
 * - Local tools (documents — path-based file I/O) merge into tools/list and
 *   dispatch locally against the Continurisk API directly.
 * - Scope-lock enforcement happens HERE (relocated from the gateway):
 *   scopeId args are asserted before local dispatch or relay, and locked
 *   grc_scopes list results are filtered to the authorized set.
 */

export interface ProxyOptions {
  readonly gatewayUrl: URL;
  readonly bearerToken: string;
  readonly registry: LocalToolRegistry;
  readonly lock: ScopeLock;
  /** Tool names hidden from `tools/list` and rejected on direct call (UX-ROUND-2-PLAN.md W3, D-U4). */
  readonly disabledTools: readonly string[];
  /** Which `grc_documents_*` implementation is exposed — see `registry/documents-mode.ts`. */
  readonly documentsMode: DocumentsMode;
  readonly log: (message: string) => void;
  readonly clientVersion: string;
  /**
   * Optional pre-connected gateway client. `cli.ts` sometimes has to connect
   * one early — e.g. to resolve a scope lock via the live gateway
   * (`grc_scopes list`, `resolveAndCacheScopeMap`) before startup — and
   * passes it here so `startProxy` reuses that connection instead of opening
   * a second one to the same gateway. Callers that omit this get the
   * original behavior: `startProxy` connects its own via `connectGateway`.
   */
  readonly gatewayClient?: Client;
}

/**
 * Inputs for a hot-reload (VSIX-PLAN §4.3 / D-V10): rebuilds the upstream
 * gateway connection and credentials in place, without dropping the stdio
 * pipe to the agent or touching the local documents registry.
 *
 * `apiBaseUrl` is deliberately distinct from `gatewayUrl`: the gateway URL
 * points at the MCP gateway (e.g. `http://localhost:3020/mcp`), while
 * `apiBaseUrl` is the underlying Continurisk API base consumed directly by
 * the local documents tools via `setApiCredentials` (e.g.
 * `http://localhost:3010`) — see `ResolvedCredentials.baseUrl` in
 * `auth/token-provider.ts` and its use in `cli.ts`.
 */
export interface ReloadOptions {
  readonly gatewayUrl: URL;
  readonly bearerToken: string;
  readonly apiBaseUrl: string;
  /**
   * The environment these credentials belong to. Carried so a caller using a
   * credential PROVIDER can re-point it at the new env on a switch, instead of
   * having the provider keep resolving the environment we just left.
   */
  readonly env?: string;
  readonly lock: ScopeLock;
  readonly disabledTools: readonly string[];
  readonly documentsMode: DocumentsMode;
}

export interface ConnectedProxy {
  readonly close: () => Promise<void>;
  /** Rebuild the upstream gateway connection + credentials + scope lock in place. */
  readonly reload: (next: ReloadOptions) => Promise<void>;
  /**
   * Read the LIVE scope lock (F3): reload() reassigns the outer-scope `let
   * lock` in place, so callers that need the current lock at call time
   * (`registerDocumentTools`'s handlers) must read it through this getter
   * rather than capturing the startup value by closure.
   */
  readonly getLock: () => ScopeLock;
  /** Read the LIVE disabled-tools set (mirrors `getLock`'s live-read pattern — W3). */
  readonly getDisabledTools: () => readonly string[];
  /** Read the LIVE documents mode (same live-read pattern; reload() reassigns it). */
  readonly getDocumentsMode: () => DocumentsMode;
  /**
   * Read the LIVE gateway client, for local tools that must call a gateway
   * tool rather than reimplement it against the REST API.
   *
   * Same live-read reason as `getLock`: reload() swaps the client, and a
   * handler that captured the old one by closure would talk to a closed
   * transport.
   */
  readonly getGatewayClient: () => Client;
  /**
   * True while a failed reload has quarantined the proxy. Exposed so `cli.ts`
   * can report the state rather than only logging the throw.
   */
  readonly isQuarantined: () => boolean;
}

/**
 * Connect a gateway `Client` over `StreamableHTTPClientTransport` with the
 * given bearer token. Exported so `cli.ts` can pre-connect a client to
 * resolve a scope lock via the live gateway *before* `startProxy` runs, then
 * hand that same connection to `startProxy` via `ProxyOptions.gatewayClient`
 * instead of connecting to the gateway twice. Also used internally by
 * `startProxy`'s default path and by `reload()` below, so there is a single
 * construction site for this connection.
 */
export async function connectGateway(gatewayUrl: URL, bearerToken: string, clientVersion: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(gatewayUrl, {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: 'fmmcp-local', version: clientVersion });
  await client.connect(transport);
  return client;
}

/** Filter a grc_scopes list result down to the authorized scope set. */
function filterScopesResult(result: CallToolResult, lock: ScopeLock, log: (message: string) => void): CallToolResult {
  const content = result.content;
  if (!Array.isArray(content) || result.isError === true) return result;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return result;
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (!Array.isArray(parsed)) return result;
    const filtered = parsed.filter((s: unknown) => {
      const id = (s as { id?: unknown; _id?: unknown }).id ?? (s as { _id?: unknown })._id;
      return typeof id === 'string' && lock.authorizedIds.has(id);
    });
    return { ...result, content: [{ type: 'text', text: JSON.stringify(filtered) }] };
  } catch (parseError: unknown) {
    log(`scope-lock: could not filter grc_scopes result (${String(parseError)}) — passing through`);
    return result;
  }
}

/**
 * Connect the upstream gateway client and start serving stdio.
 * Fails fast if the gateway is unreachable or rejects initialize.
 */
export async function startProxy(options: ProxyOptions): Promise<ConnectedProxy> {
  const { gatewayUrl, bearerToken, registry, log, clientVersion } = options;
  // `lock` is reassigned in reload() below (a fresh ScopeLock per switch), so
  // it is bound with `let` here in startProxy's function scope — the
  // setRequestHandler closures further down read this same outer binding on
  // every invocation, so a plain reassignment (never a nested `const` inside
  // reload()) is all that's needed for them to observe the new lock.
  let { lock } = options;

  // Same live-reassignment pattern as `lock`, for the W3 tool selector — a
  // `Set` for O(1) membership checks on every tools/list + CallTool.
  let disabledTools = new Set(options.disabledTools);

  // Same live-reassignment pattern again, for the documents mode: a config.json
  // edit reaches the running proxy through reload(), and BOTH handlers below
  // must observe the new value on their next invocation.
  let documentsMode = options.documentsMode;

  // Quarantine after a failed reload — see reload-state.ts for why a failed
  // reload must NOT keep serving the previous environment and scope.
  const reloadState = new ReloadState();

  // ── Upstream: streamable HTTP client to the gateway ────────
  // Reassigned in reload() below when the upstream gateway connection is
  // rebuilt — bound with `let` for the same reason as `lock` above.
  let gatewayClient: Client;
  if (options.gatewayClient !== undefined) {
    gatewayClient = options.gatewayClient;
    log(`Reusing pre-connected gateway client for ${gatewayUrl.toString()}`);
  } else {
    gatewayClient = await connectGateway(gatewayUrl, bearerToken, clientVersion);
    log(`Connected to gateway at ${gatewayUrl.toString()}`);
  }

  // ── Downstream: stdio server facing the IDE ────────────────
  // McpServer wrapper for lifecycle, but handlers go on the underlying
  // low-level `.server`: the proxy must relay the gateway's JSON Schemas
  // verbatim, which registerTool (Zod-only) cannot express.
  const mcp = new McpServer(
    { name: 'fortmesa', version: clientVersion },
    { capabilities: { tools: { listChanged: true } } },
  );
  const server = mcp.server;

  /**
   * The gateway's tool shapes change on deploy, not per request, so asking it
   * every time is a round trip an agent pays for nothing. Cached for a fixed
   * window, refreshed on expiry, and invalidated by reload() below (which is
   * the one moment the answer is known to have changed).
   *
   * The client is read through the closure at call time rather than captured,
   * so a reload's replacement client is used by the next refresh.
   */
  const schemaCache = new ToolSchemaCache({
    fetchTools: async () => gatewayClient.listTools(),
    log,
  });

  server.setRequestHandler('tools/list', async () => {
    const upstream = { tools: await schemaCache.get() };

    // A local tool SHADOWS the gateway's tool of the same name, so the same name is never
    // advertised twice with two different schemas (which one an agent validates against
    // would be a coin flip). The `grc_documents_*` trio exists on both sides on purpose,
    // and which side wins is now the user's choice rather than a hard-coded filter —
    // `mergeToolLists` owns that rule, and `tools/call` below routes by the same one, so
    // the advertised list and the routing cannot drift apart.
    return { tools: mergeToolLists(upstream.tools, registry.listDefs(), documentsMode, disabledTools) };
  });

  /**
   * Bridge one MCP request to a {@link ToolContext}.
   *
   * `progressToken` is only present when the client asked to be kept informed.
   * Absent it, every report is dropped: a `notifications/progress` without a
   * token is malformed, and sending one unasked is worse than sending nothing.
   *
   * Failures are swallowed. Progress is advisory, and a notification that cannot
   * be delivered must never fail the tool call it was reporting on.
   */
  function makeToolContext(
    progressToken: string | number | undefined,
    ctx: { mcpReq: { notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> } },
  ): ToolContext {
    if (progressToken === undefined) return NO_TOOL_CONTEXT;

    return {
      reportProgress: async (progress, message) => {
        try {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress, ...(message === undefined ? {} : { message }) },
          });
        } catch {
          // Advisory only -- see above.
        }
      },
    };
  }

  server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    // A failed reload left this proxy bound to an environment/scope the user
    // has already moved away from. Refuse everything rather than quietly keep
    // serving it — including local tools, since the credentials behind them
    // are part of the same stale binding.
    const blockedReason = reloadState.blockedReason;
    if (blockedReason !== undefined) {
      return toolError(blockedReason);
    }

    // W3 tool selector (D-U4): a disabled tool is absent from tools/list, but
    // a stale/direct call must still be rejected with a clear isError rather
    // than silently falling through to local dispatch or gateway relay.
    if (disabledTools.has(name)) {
      return toolError(`tool '${name}' is disabled in Saferoom settings`);
    }

    // Scope-lock enforcement (relocated from the gateway): reject any call
    // naming an unauthorized scope before it does local I/O or leaves the box.
    const scopeId = args.scopeId;
    if (typeof scopeId === 'string' && scopeId !== '') {
      try {
        lock.assertAuthorized(scopeId);
      } catch (lockError: unknown) {
        return toolError(lockError instanceof Error ? lockError.message : String(lockError));
      }
    }

    // Same rule as the advertised list — in network mode a documents call falls
    // through to the gateway relay below instead of the local registry.
    if (dispatchesLocally(name, documentsMode, registry.has(name))) {
      return registry.call(name, args, makeToolContext(request.params._meta?.progressToken, ctx));
    }

    // F9: a reload() in flight can close the OLD gateway client out from
    // under a call already in progress against it (reload() below connects
    // the new client before closing the old one, but an in-flight call on
    // the old client can still see its transport closed mid-request).
    // Surface a clear, retryable error instead of a raw transport rejection.
    let result: CallToolResult;
    try {
      result = await gatewayClient.callTool({ name, arguments: args });
    } catch (relayError: unknown) {
      const detail = relayError instanceof Error ? relayError.message : String(relayError);
      log(`CallTool relay failed for "${name}" (${detail})`);
      // Do NOT assert a cause we have not established. This catch sees EVERY relay failure --
      // upstream rate limiting, a saturated gateway connection under a wide parallel burst, an
      // API timeout -- not just the reload() race the F9 note above describes. Reporting all of
      // them as "environment switched" handed agents a confident and usually false diagnosis
      // while discarding the only useful information, the underlying error (2026-09-02 defect
      // report, ADDITIONAL). Retry advice is still correct; the attribution was not.
      return toolError(`gateway call for '${name}' failed and may be retryable: ${detail}`);
    }
    if (name === 'grc_scopes' && args.method === 'list' && lock.isLocked) {
      return filterScopesResult(result, lock, log);
    }
    return result;
  });

  const stdioTransport = new StdioServerTransport();
  await mcp.connect(stdioTransport);
  // NOTE: `registry` may still be empty at this exact point — cli.ts's
  // runProxy registers the local documents tools AFTER this function
  // resolves (F3: so they can capture a `getLock` closure over the fully
  // constructed `ConnectedProxy` instead of the pre-fix stale `lock` value),
  // with no intervening `await`, so nothing can observe an incomplete
  // registry before it's populated. `cli.ts` logs the final tool list itself
  // once registration completes — logging `registry.names()` here would
  // always print `[]`.
  log('Local MCP started (stdio) — connected to the gateway; local tool registration follows.');

  return {
    close: async () => {
      await mcp.close();
      await gatewayClient.close();
    },

    getLock: () => lock,

    getDisabledTools: () => [...disabledTools],

    getDocumentsMode: () => documentsMode,
    getGatewayClient: () => gatewayClient,

    isQuarantined: () => reloadState.isQuarantined,

    // Hot-reload (VSIX-PLAN §4.3 / D-V10): the stdio pipe to the agent and
    // the local documents registry are left untouched — only the upstream
    // gateway connection and the credentials/lock it carries are rebuilt.
    //
    // F1: connect the NEW gateway FIRST, then swap the outer-scope bindings,
    // and only THEN close the OLD client (best-effort). If the new gateway is
    // unreachable, `connectGateway` throws before anything is mutated — the
    // OLD client and OLD lock keep serving every request, untouched.
    reload: async (next: ReloadOptions): Promise<void> => {
      log(`Reload: connecting to gateway at ${next.gatewayUrl.toString()}`);
      let nextClient: Client;
      try {
        nextClient = await connectGateway(next.gatewayUrl, next.bearerToken, clientVersion);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        // Do NOT keep serving the previous environment and scope. The user has
        // already moved on in the Saferoom UI; continuing would leave the agent
        // holding access to the scope the user believes they left, invisibly.
        // Quarantine instead: every call is refused with an explanation until a
        // reload succeeds. Nothing else is mutated, so a later successful reload
        // recovers cleanly.
        reloadState.markFailed(detail);
        log(
          `Reload to ${next.gatewayUrl.toString()} failed: ${detail} — QUARANTINED: refusing all tool calls ` +
            `until a reload succeeds (the previous environment and scope are no longer served)`,
        );
        throw error;
      }
      log(`Reload: connected to gateway at ${next.gatewayUrl.toString()}`);

      const previousClient = gatewayClient;

      // Reassign the outer-scope bindings (no nested `const` — see the
      // declarations above) so the existing setRequestHandler closures pick
      // these up on their next invocation.
      gatewayClient = nextClient;
      // The new gateway may publish different tools; do not serve the old ones.
      schemaCache.invalidate();
      lock = next.lock;
      disabledTools = new Set(next.disabledTools);
      documentsMode = next.documentsMode;
      // A provider re-resolves per request, so replacing it with the token
      // captured at reload time would reintroduce exactly the staleness it
      // exists to prevent. Re-point it at the new env instead; only fall back
      // to fixed credentials when no provider is installed.
      if (!onCredentialEnvChange(next.env)) setApiCredentials(next.bearerToken, next.apiBaseUrl);
      log(`Reload: local documents tools now targeting API base ${next.apiBaseUrl}`);

      reloadState.markSucceeded();

      mcp.sendToolListChanged();
      log('Reload: sent tools/list_changed notification to the agent');

      await previousClient.close().catch((closeError: unknown) => {
        log(
          `Reload: error closing previous gateway connection (ignored): ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      });
    },
  };
}
