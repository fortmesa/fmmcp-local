import { z } from 'zod';
import { toolError } from '../../shared/tool-helpers.js';

/**
 * Local tool registry.
 *
 * The migrated gateway tool files register via the same
 * `registerTool(name, config, handler)` shape they used against McpServer —
 * this registry captures those registrations instead, because the proxy runs
 * the low-level `Server` (it must relay the gateway's JSON Schemas verbatim,
 * which `McpServer.registerTool` cannot express).
 *
 * The registry converts each Zod input shape to JSON Schema once (zod4 native
 * `z.toJSONSchema`) for tools/list, and validates arguments with the same Zod
 * shape on every call — matching McpServer's behavior.
 */

/** Result shape produced by toolResult()/toolError() in tool-helpers. */
export interface ToolHandlerResult {
  /** Index signature for assignability to the SDK's CallToolResult. */
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: true;
}

export interface ToolAnnotations {
  /**
   * Display name for older clients, which read it here rather than at the top
   * level. Must equal the top-level `title` or the tool renders inconsistently
   * depending on which spec version the client implements.
   */
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolConfig<TShape extends z.ZodRawShape> {
  /** Display name, preferred by clients on the 2025-06-18 spec. */
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: TShape;
}

/**
 * Per-call channel back to the MCP client, for work that outlives a client's
 * patience.
 *
 * The SDK's default request timeout is 60s (DEFAULT_REQUEST_TIMEOUT_MSEC), and
 * the spec lets a client reset that clock on a progress notification, "as this
 * implies that work is actually happening". A 50MB upload needs ~80s of
 * transfer at 5 Mbps, so without these it is cancelled mid-flight no matter
 * what timeout the HTTP layer allows.
 *
 * Resetting is MAY, not MUST, so a client is free to ignore them; nothing here
 * may depend on the extra time being granted.
 */
export interface ToolContext {
  /**
   * Emit `notifications/progress` for this call. `progress` MUST increase
   * across calls within one request (spec requirement).
   *
   * A no-op when the client sent no `progressToken` — it did not ask to be
   * told, and an unsolicited token-less notification is malformed.
   */
  readonly reportProgress: (progress: number, message?: string) => Promise<void>;
}

/** A context that discards everything, for callers with no MCP request in hand. */
export const NO_TOOL_CONTEXT: ToolContext = { reportProgress: () => Promise.resolve() };

/** Structural stand-in for McpServer.registerTool — see module doc. */
export interface ToolRegistrar {
  registerTool<TShape extends z.ZodRawShape>(
    name: string,
    config: ToolConfig<TShape>,
    handler: (args: z.output<z.ZodObject<TShape>>, ctx: ToolContext) => Promise<ToolHandlerResult>,
  ): void;
}

interface StoredTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly jsonSchema: LocalToolDef['inputSchema'];
  readonly handler: (args: never, ctx: ToolContext) => Promise<ToolHandlerResult>;
}

/**
 * MCP tools/list entry (JSON Schema form, matching what the gateway emits).
 *
 * `inputSchema` carries an explicit `type: 'object'` because SDK v2 types the
 * tools/list result strictly: a bare `Record<string, unknown>` no longer
 * satisfies the tool schema, which requires the object type discriminant.
 */
export interface LocalToolDef {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

/**
 * Tool display/behaviour metadata, mirroring fmmcp-gw's `shared/tool-helpers.ts`.
 *
 * These tools are republished by the proxy alongside the gateway's own, and the
 * proxy SHADOWS a gateway tool of the same name with the local one. If the two
 * sides disagree about a title or a hint, the shadowed copy silently wins and the
 * surface becomes inconsistent depending on which server a client reaches. So the
 * policy is copied rather than re-derived. Keep it in step with the gateway
 * (docs/TOOLS.md, Tool annotations).
 *
 *  - readOnlyHint    - does the tool write?
 *  - destructiveHint - is the tool PURELY ADDITIVE? If not, `true`, which is also
 *                      the spec default for a non-read-only tool.
 *  - idempotentHint  - absolute-state setters only.
 *  - openWorldHint   - `true` everywhere: every tool returns customer-authored GRC
 *                      content across a network boundary from a multi-tenant backend.
 */
function toolMeta(title: string, hints: { readOnly: boolean; destructive: boolean; idempotent: boolean }) {
  return {
    title,
    annotations: {
      title,
      readOnlyHint: hints.readOnly,
      destructiveHint: hints.destructive,
      idempotentHint: hints.idempotent,
      openWorldHint: true,
    },
  };
}

/** Read-only tool: never writes, safe to repeat. */
export function readTool(title: string) {
  return toolMeta(title, { readOnly: true, destructive: false, idempotent: true });
}

/** Mutating tool. Not purely additive (overwrites, removes, or drives a terminal transition). */
export function writeTool(title: string) {
  return toolMeta(title, { readOnly: false, destructive: true, idempotent: false });
}

export class LocalToolRegistry implements ToolRegistrar {
  private readonly tools = new Map<string, StoredTool>();

  registerTool<TShape extends z.ZodRawShape>(
    name: string,
    config: ToolConfig<TShape>,
    handler: (args: z.output<z.ZodObject<TShape>>, ctx: ToolContext) => Promise<ToolHandlerResult>,
  ): void {
    const schema = z.object(config.inputSchema);
    this.tools.set(name, {
      name,
      title: config.title,
      description: config.description,
      annotations: config.annotations,
      schema: schema,
      // `schema` is always a z.object(), so the emitted JSON Schema always
      // carries `type: 'object'` — z.toJSONSchema's return type is the general
      // schema union and can't express that.
      jsonSchema: z.toJSONSchema(schema) as LocalToolDef['inputSchema'],
      handler: handler,
    });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  listDefs(): LocalToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      annotations: t.annotations,
      inputSchema: t.jsonSchema,
    }));
  }

  /** Validate args against the tool's Zod shape and dispatch. */
  async call(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext = NO_TOOL_CONTEXT,
  ): Promise<ToolHandlerResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return toolError(`Unknown local tool: ${name}`);
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return toolError(`Input validation error: Invalid arguments for tool ${name}: ${issues}`);
    }
    return tool.handler(parsed.data as never, ctx);
  }
}
