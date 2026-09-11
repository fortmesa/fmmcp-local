/**
 * Documents tools mode — Local-file vs Network (PO, 2026-09-10).
 *
 * The three `grc_documents_*` tools exist on BOTH sides of the proxy: the
 * local MCP registers path-based file I/O versions (`local-mcp/tools/
 * documents.ts`), and the cloud gateway publishes URL-based (presigned S3)
 * versions of the same three names for clients that reach it directly.
 *
 * Until this module existed the local trio ALWAYS won: `proxy.ts`'s
 * `tools/list` unconditionally shadowed any gateway tool whose name a local
 * tool also used, and `tools/call` unconditionally preferred the registry.
 * That is the right default — it is the 2026-09-05 ruling, "Local VSIX should
 * disable redundant tools by default" — but it was hard-coded in a filter,
 * invisible in Settings, and unreachable: no combination of the existing
 * per-tool checkboxes could expose the gateway's URL-based trio, because both
 * sides answer to the same three names and one checkbox governed both.
 *
 * So the choice becomes an explicit, persisted MODE, and the same two decision
 * points in the proxy now consult it. This module owns the whole decision:
 * the option copy the Settings panel renders, the merge rule `tools/list`
 * applies, and the routing rule `tools/call` applies. It is deliberately
 * `vscode`-free (VSIX-PLAN.md §3.1) so all three are testable — a decision
 * buried in a webview string literal is unreachable by every test here, which
 * is how the previous default shipped unexamined.
 */

/** Which implementation of the documents tools an agent gets. */
export type DocumentsMode = 'local' | 'network';

/**
 * The three names that exist on both sides. Fixed and versioned here rather
 * than derived from a live `tools/list`, so Settings can render the section
 * with no gateway reachable. Mirrors the `registerTool` calls in
 * `local-mcp/tools/documents.ts`.
 */
export const DOCUMENTS_TOOL_NAMES = ['grc_documents_read', 'grc_documents_write', 'grc_documents_delete'] as const;

/**
 * Local-file mode is the default: it preserves the behaviour every earlier
 * version shipped, and it is what the 2026-09-05 ruling asked for.
 */
export const DEFAULT_DOCUMENTS_MODE: DocumentsMode = 'local';

export function isDocumentsMode(value: unknown): value is DocumentsMode {
  return value === 'local' || value === 'network';
}

export function isDocumentsToolName(name: string): boolean {
  return (DOCUMENTS_TOOL_NAMES as readonly string[]).includes(name);
}

export interface DocumentsModeOption {
  readonly id: DocumentsMode;
  /** Sentence case, per the PO's wording. */
  readonly label: string;
  /** The one-paragraph explanation shown above the table while this mode is selected. */
  readonly preamble: string;
}

const LOCAL_MODE_OPTION: DocumentsModeOption = {
  id: 'local',
  label: 'Local-file mode',
  preamble:
    'The extension handles documents on this machine: agents read and write files by path in your workspace, ' +
    'and the extension uploads and downloads them through your signed-in session. The gateway\u2019s URL-based ' +
    'document tools are shadowed while this mode is selected, so each tool name appears exactly once.',
};

const NETWORK_MODE_OPTION: DocumentsModeOption = {
  id: 'network',
  label: 'Network mode',
  preamble:
    'The gateway\u2019s URL-based tools are exposed instead: agents receive signed upload and download links and ' +
    'move the bytes themselves. Nothing touches your workspace \u2014 there is no local file access in this mode, ' +
    'so an agent that cannot fetch a link cannot retrieve the document.',
};

/** Display order IS array order. */
export const DOCUMENTS_MODE_OPTIONS: readonly DocumentsModeOption[] = [LOCAL_MODE_OPTION, NETWORK_MODE_OPTION];

export function documentsModeOption(mode: DocumentsMode): DocumentsModeOption {
  // Indexed rather than searched, so the compiler proves an option exists for
  // every mode: a `find()` here would be `| undefined` and need a fallback,
  // which is how a third mode added later would silently render as the first.
  return mode === 'network' ? NETWORK_MODE_OPTION : LOCAL_MODE_OPTION;
}

export interface DocumentsToolRow {
  readonly name: string;
  readonly description: string;
}

/**
 * The three rows the Documents table shows, described AS THE ACTIVE MODE
 * behaves. The same name means something materially different in each mode,
 * and showing one mode's description while the other is live is precisely the
 * confusion the PO reported.
 */
const DOCUMENTS_TOOL_ROWS: Record<DocumentsMode, readonly DocumentsToolRow[]> = {
  local: [
    { name: 'grc_documents_read', description: 'List documents, and download one to a path in your workspace.' },
    { name: 'grc_documents_write', description: 'Upload or update a document from a path in your workspace.' },
    { name: 'grc_documents_delete', description: 'Permanently delete a document (no workspace file is touched).' },
  ],
  network: [
    { name: 'grc_documents_read', description: 'List documents, and return a signed download URL for one.' },
    { name: 'grc_documents_write', description: 'Return a signed upload URL; the agent transfers the bytes itself.' },
    { name: 'grc_documents_delete', description: 'Permanently delete a document (server-side, two-phase).' },
  ],
};

export function documentsToolRows(mode: DocumentsMode): readonly DocumentsToolRow[] {
  return DOCUMENTS_TOOL_ROWS[documentsModeOption(mode).id];
}

/** Everything the Settings panel's Documents section renders, decided host-side. */
export interface DocumentsSectionView {
  readonly mode: DocumentsMode;
  readonly options: readonly DocumentsModeOption[];
  readonly preamble: string;
  readonly rows: readonly DocumentsToolRow[];
}

export function documentsSectionView(mode: DocumentsMode): DocumentsSectionView {
  const option = documentsModeOption(mode);
  return {
    mode: option.id,
    options: DOCUMENTS_MODE_OPTIONS,
    preamble: option.preamble,
    rows: documentsToolRows(option.id),
  };
}

/**
 * The advertised `tools/list`, given the gateway's tools, the local registry's
 * tools, the mode, and the disabled-tool set.
 *
 * A local tool SHADOWS the gateway's tool of the same name — except that in
 * network mode the local documents trio is not offered for shadowing at all,
 * which is what lets the gateway's verbatim URL-based schemas through. The
 * disabled-tool filter is applied last, so an unchecked box still hides a tool
 * in either mode.
 */
/** Methods this process adds to a gateway documents tool, because they touch the filesystem. */
export const LOCAL_ONLY_METHODS: Readonly<Record<string, readonly string[]>> = {
  grc_documents_read: ['download'],
  grc_documents_write: ['upload'],
};

/**
 * Take the GATEWAY's schema and add only what this process contributes.
 *
 * The VSIX is installed by a user and then rarely updated, so anything copied
 * into it freezes on the day it shipped. The gateway, by contrast, is deployed
 * continuously: it gained three `assetInventoryReport-*` types and lost a
 * disabled one on 2026-09-11, and a hardcoded copy here would have made the new
 * ones unreachable for every installed VSIX until the user upgraded.
 *
 * So the gateway's tool is the source of truth for the description, the
 * `documentType` vocabulary and every other property, and this only widens the
 * `method` enum and adds `filePath`. A type or method added upstream tomorrow
 * reaches an old VSIX with no release.
 *
 * Returns the gateway tool unchanged when it contributes nothing, and null when
 * there is no gateway tool of that name to build on.
 */
export function augmentGatewayTool<T extends { name: string; description?: string; inputSchema?: unknown }>(
  gatewayTool: T,
): T {
  const extra = LOCAL_ONLY_METHODS[gatewayTool.name];
  if (extra === undefined || extra.length === 0) return gatewayTool;

  const schema = gatewayTool.inputSchema;
  if (schema === null || typeof schema !== 'object') return gatewayTool;

  const root = { ...(schema as Record<string, unknown>) };
  const props = { ...((root.properties as Record<string, unknown> | undefined) ?? {}) };

  // Widen only an enum the gateway actually published. Building one from
  // nothing would advertise the added methods as the ONLY legal values and
  // hide every method the gateway does support, which is worse than not
  // widening at all. A schema shaped in any other way is one this code does
  // not understand, so it is relayed exactly as published.
  const method = props.method;
  if (method === null || typeof method !== 'object') return gatewayTool;
  const m = { ...(method as Record<string, unknown>) };
  if (!Array.isArray(m.enum)) return gatewayTool;
  const values = m.enum as unknown[];
  const added = extra.filter((value) => !values.includes(value));
  m.enum = [...values, ...added];
  props.method = m;

  props.filePath = {
    type: 'string',
    description: extra.includes('download')
      ? 'Local path to write the downloaded file to (required for download).'
      : 'Local path of the file to upload (required for upload).',
  };

  root.properties = props;
  return {
    ...gatewayTool,
    description:
      `${gatewayTool.description ?? ''}\n\nThis local server adds: ${extra.join(', ')} - ` +
      'the same operations against a path on this machine. Every other method is relayed to the gateway.',
    inputSchema: root,
  };
}

export function mergeToolLists<TGateway extends { name: string }, TLocal extends { name: string }>(
  gatewayTools: readonly TGateway[],
  localTools: readonly TLocal[],
  mode: DocumentsMode,
  disabled: ReadonlySet<string>,
): (TGateway | TLocal)[] {
  // Network mode: pure relay, the gateway's tools exactly as published.
  if (mode === 'network') {
    return gatewayTools.filter((tool) => !disabled.has(tool.name));
  }

  // Local mode: the gateway's tool, WIDENED with the filesystem methods this
  // process adds. Previously the local copy replaced the gateway's outright,
  // which froze the schema at VSIX-install time -- see augmentGatewayTool.
  const gatewayNames = new Set(gatewayTools.map((tool) => tool.name));
  const merged: (TGateway | TLocal)[] = [
    ...gatewayTools.map((tool) => augmentGatewayTool(tool)),
    // A local tool with no gateway counterpart still has to be advertised from
    // here; with one, the gateway's definition already won above.
    ...localTools.filter((tool) => !gatewayNames.has(tool.name)),
  ];
  return merged.filter((tool) => !disabled.has(tool.name));
}

/**
 * Does this call dispatch to the LOCAL registry, or relay to the gateway?
 *
 * Must agree with {@link mergeToolLists} for every name, or an agent validates
 * against one implementation's schema and reaches the other's.
 */
export function dispatchesLocally(name: string, mode: DocumentsMode, registryHas: boolean): boolean {
  if (!registryHas) return false;
  return !(mode === 'network' && isDocumentsToolName(name));
}
