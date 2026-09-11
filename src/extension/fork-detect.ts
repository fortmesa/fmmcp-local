import * as vscode from 'vscode';

/**
 * Fork/host capability detection at extension activation
 * (VSIX-PLAN.md curriculum 05 "Fork detection at activation").
 *
 * `@types/vscode` only declares the API surface real VS Code ships. Cursor's
 * proprietary `cursor.mcp` namespace (curriculum 04 §3 — Cursor does NOT
 * implement `vscode.lm.registerMcpServerDefinitionProvider`) isn't part of
 * it, and even the standard `vscode.lm` namespace may be genuinely absent at
 * runtime on a fork such as Antigravity (curriculum 04 §5) despite
 * `@types/vscode` declaring it as an always-present namespace. Rather than
 * casting the whole `vscode` import to `any` (banned by
 * `@typescript-eslint/no-explicit-any`), this module declares a minimal
 * ambient shape for just the pieces it probes and casts through `unknown`
 * into that shape — every member access below is against a real, known
 * (optional) type, so `no-unsafe-member-access` / `no-unsafe-assignment` /
 * `no-unnecessary-condition` never fire.
 *
 * This module only detects; it does not itself register anything with
 * Cursor's live API (that stays a file-based projector — see
 * `src/registry/projectors/cursor.ts` — per VSIX-PLAN.md §3.3's "API
 * preferred, file fallback" note; wiring the live Cursor path is a later
 * phase's work). The result here is purely informational at this phase:
 * logged at activation so later phases have a capability baseline to reason
 * about, and so `mcp-provider.ts` doesn't need to duplicate the `lm`
 * feature-detection logic (`registerMcpProvider` re-derives the same check
 * internally for its own no-op decision, using the identical technique).
 */

/** The one Cursor MCP method we need to detect the presence of; kept `unknown`-typed since this module never calls through it. */
interface CursorMcpNamespace {
  readonly registerServer?: unknown;
}

/**
 * Ambient shape for the pieces of a Cursor-fork `vscode` module that
 * `@types/vscode` doesn't declare. Every member is optional — that is
 * exactly what makes the optional-chaining checks below meaningful (not
 * "unnecessary") on a standard VS Code build where `cursor` is absent.
 */
interface CursorForkGlobal {
  readonly cursor?: {
    readonly mcp?: CursorMcpNamespace;
  };
}

/**
 * Ambient shape for the one `vscode.lm` member this module probes. Declared
 * separately from (and narrower than) `@types/vscode`'s own non-optional
 * `lm` namespace type so a host that omits `vscode.lm` entirely narrows to
 * `undefined` instead of the type checker assuming it always exists.
 */
interface OptionalLmGlobal {
  readonly lm?: {
    readonly registerMcpServerDefinitionProvider?: unknown;
  };
}

export interface DetectedCapabilities {
  /** `true` when this host implements `vscode.lm.registerMcpServerDefinitionProvider` (VS Code ~1.102+; absent on forks like Antigravity). */
  readonly hasLmMcpProvider: boolean;
  /** `true` when this host exposes Cursor's proprietary `vscode.cursor.mcp.registerServer` API. */
  readonly hasCursorMcpApi: boolean;
  /** `true` when running in a remote extension host (`vscode.env.remoteName !== undefined`) — this pod's VS Code Server is always remote; see curriculum 05 "Remote-context correctness". */
  readonly isRemote: boolean;
}

function hasCursorMcpApi(module: typeof vscode): boolean {
  if (!('cursor' in module)) return false;
  const cursorNamespace = (module as unknown as CursorForkGlobal).cursor;
  return typeof cursorNamespace?.mcp?.registerServer === 'function';
}

function hasLmMcpProvider(module: typeof vscode): boolean {
  if (!('lm' in module)) return false;
  const lmNamespace = (module as unknown as OptionalLmGlobal).lm;
  return typeof lmNamespace?.registerMcpServerDefinitionProvider === 'function';
}

/**
 * Detect the current host's MCP-relevant capability set. Pure with respect
 * to the running process — reads only `vscode`'s own module shape and
 * `vscode.env`, never touches disk or network — so it's safe to call
 * unconditionally and cheaply at every activation.
 */
export function detectCapabilities(): DetectedCapabilities {
  return {
    hasLmMcpProvider: hasLmMcpProvider(vscode),
    hasCursorMcpApi: hasCursorMcpApi(vscode),
    isRemote: vscode.env.remoteName !== undefined,
  };
}
