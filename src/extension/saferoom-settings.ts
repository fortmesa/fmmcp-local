import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Client } from '@modelcontextprotocol/client';
import { resolveCredentials } from '../local-mcp/auth/token-provider.js';
import { connectGateway } from '../local-mcp/proxy.js';
import { addCustomServer, loadConfig, removeCustomServer, saveConfig, type Config } from '../registry/config.js';
import {
  decodeJwtExpiry,
  decodeJwtSubject,
  fetchIdentity,
  formatExactExpiry,
  formatRelativeExpiry,
  identityPrimaryLabel,
  readCurrentToken,
  type Identity,
} from '../registry/credentials.js';
import {
  accessTokenUrl,
  appLaunchUrl,
  ENVIRONMENTS,
  environmentChoices,
  environmentLabel,
} from '../registry/environments.js';
import { mergeServerList, SERVER_NAME_MAX } from '../registry/custom-servers.js';
import { readRegionCredentialState, regionChipLabel, type RegionCredentialState } from '../registry/region-identity.js';
import { agentRowLabels, type AgentChip } from '../registry/agent-status.js';
import {
  documentsModeOption,
  documentsSectionView,
  isDocumentsMode,
  isDocumentsToolName,
  type DocumentsSectionView,
} from '../registry/documents-mode.js';
import {
  isSettingsSectionId,
  resolveSettingsSections,
  withSectionOpen,
  SETTINGS_SECTIONS_KEY,
  type SettingsSectionId,
  type SettingsSectionView,
} from '../registry/settings-sections.js';
import * as antigravity from '../registry/projectors/antigravity.js';
import * as copilot from '../registry/projectors/copilot.js';
import * as claude from '../registry/projectors/claude.js';
import * as codex from '../registry/projectors/codex.js';
import * as cursor from '../registry/projectors/cursor.js';
import { submitAccessToken } from './auth-commands.js';
import { detectCapabilities } from './fork-detect.js';
import { errorMessage, type Logger } from './logger.js';
import { IDE_SYNC_TARGETS, setIdeSyncTarget, type IdeSyncTarget } from './ide-sync-commands.js';

/**
 * "Settings" (UX-ROUND-2-PLAN.md W10, D-U6/D-U8) — the bespoke webview panel
 * opened by the Saferoom launcher's "Settings" CTA
 * (`fortmesa.openSaferoomSettings`, `tree-view.ts`).
 *
 * NOT the embedded FortMesa SPA — `fmweb-be/src/server.ts` sets
 * `X-Frame-Options: DENY` (`helmet({ xFrameOptions: { action: 'deny' } })`),
 * so the real app cannot be iframed/webview-embedded at all (D-U6). This is
 * a hand-authored panel that is the *complete superset* of the native
 * panels (D-U8). Section order is fixed by the PO (2026-09-03): Scope,
 * Identity, Tools, Agents, Data region. Agents (the five IDE sync targets),
 * Tools (W3's `disabledTools`) and Data region (the environment picker,
 * renamed from "Environment") are fully functional here; Scope and Identity
 * are mirrored read-only (their native panels — `tree-view.ts`'s Scope
 * selector / Account views, plus the Scope selection panel — remain the
 * interactive surface for those two).
 *
 * **Identity › Advanced: paste an access token** (PO, 2026-09-05: "advanced
 * paste an access token form should be exposed in the settings section via
 * an advanced expansion (not in the sidebar view)"). This control, with its
 * PO-approved warning copy and its `/accountProfile#createToken` deep link,
 * used to be an inline expansion in the sidebar's Signed-in user view; that
 * view now carries sign-in, sign-out and identity only. The copy is
 * reproduced verbatim — it is the whole point of the control (it states why
 * the recommended route is recommended, and what the year-long lifetime of
 * a pasted token actually costs). Do not paraphrase it. The CLI `token set`
 * path is untouched.
 *
 * Bridge contract (webview <-> extension host via `postMessage`):
 *   webview -> host:  { type: 'getState' }
 *                      { type: 'setEnv', env: string }
 *                      { type: 'toggleIdeTarget', target: IdeSyncTarget, enabled: boolean }
 *                      { type: 'toggleTool', tool: string, enabled: boolean }
 *                      { type: 'submitToken', env, token, apiBase? }
 *                      { type: 'openTokenUi', env }
 *   host -> webview:   { type: 'state', payload: SaferoomSettingsState }
 *                      { type: 'submitResult', ok, message, needsApiBase? }
 * Every mutating message is followed by a fresh `state` message reflecting
 * what was actually saved (never an optimistic echo of the request) — the
 * webview only ever renders from the most recent `state` message.
 */

interface ToolEntry {
  readonly name: string;
  readonly description: string;
}

interface EnvironmentEntry {
  readonly name: string;
  readonly label: string;
  readonly advanced: boolean;
  readonly gateway: string;
  readonly app: string;
  /** True for a server the user added. Only these can be removed. */
  readonly custom: boolean;
  /**
   * Whether this region holds a credential, and of what kind
   * (`registry/region-identity.ts`). Rendered as a chip beside the region so
   * a saved-but-inactive credential is VISIBLE — the reported defect was that
   * a token saved for `next` left no trace anywhere in the UI while `prod`
   * stayed active and empty.
   */
  readonly credentialState: RegionCredentialState;
  /** The chip's words, decided by the host so this webview never invents a state name (same rule as the Agents chips). */
  readonly credentialChip: string;
}

/** One labelled row of the Identity table (PO, 2026-09-03: "rework into table, this string smush is non-intuitive and too dense"). */
interface IdentityField {
  readonly label: string;
  readonly value: string;
}

/**
 * One Agents row, already LABELLED host-side by
 * `registry/agent-status.ts` — the webview renders chips and never decides
 * what a state is called (PO, 2026-09-05 + 6a). The old shape carried a
 * free-text `detectionNote` sentence per row; see that module for why.
 */
interface AgentEntry {
  readonly target: IdeSyncTarget;
  readonly enabled: boolean;
  readonly name: string;
  readonly chips: readonly AgentChip[];
  readonly hint?: string;
  /** True when the row should offer the inline "Connect" action (installed/this-editor, but not connected). */
  readonly canConnect: boolean;
}

/** One selectable environment in the Identity › Advanced access-token control (moved here from the sidebar, 2026-09-05). */
interface TokenEnvChoice {
  readonly name: string;
  readonly label: string;
  readonly active: boolean;
  readonly tokenUrl: string;
}

interface SaferoomSettingsState {
  readonly activeEnv: string;
  readonly environments: readonly EnvironmentEntry[];
  /** Every CONFIGURED environment, active first — seeding credentials for a non-active region is otherwise unreachable. */
  readonly tokenEnvironments: readonly TokenEnvChoice[];
  readonly agents: readonly AgentEntry[];
  readonly disabledTools: readonly string[];
  /** Every tool EXCEPT the three documents tools — those get their own table (PO, 2026-09-10). */
  readonly allTools: readonly ToolEntry[];
  /** The Documents table: mode, both options with their preambles, and the three rows described as the ACTIVE mode behaves. */
  readonly documents: DocumentsSectionView;
  readonly toolsFetchError?: string;
  readonly scopeSummary: string;
  readonly identityFields: readonly IdentityField[];
  /** The five sections in display order, each with its resolved open/closed state. */
  readonly sections: readonly SettingsSectionView[];
}

/** The four file-based IDE-sync targets' `detect()` modules — mirrors `sync.ts`'s `FILE_PROJECTORS` (display-only here; never calls `project()`). */
const FILE_PROJECTOR_DETECTORS: Record<
  'claude' | 'cursor' | 'codex' | 'antigravity' | 'copilot',
  { detect(): Promise<boolean> }
> = { claude, cursor, codex, antigravity, copilot };

/**
 * Live per-target detection state for the Agents section (restores what the
 * pre-webview tree's Agents section showed — user feedback 2026-07-07 caught
 * this as a real regression, not an intentional simplification). The four
 * file-based targets get a real `detect()` probe (their CLI on PATH, or
 * their config directory already existing); `vscode` has no file-based
 * detection concept — its "detected" state is whether THIS host implements
 * `vscode.lm.registerMcpServerDefinitionProvider` at all (`fork-detect.ts`,
 * the same check `mcp-provider.ts` uses for its own no-op decision).
 */
async function buildAgentEntries(ideSync: Config['ideSync']): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];

  for (const target of IDE_SYNC_TARGETS) {
    const enabled = ideSync[target];

    if (target === 'vscode') {
      // The host editor is present by definition, so "installed" is not the
      // question for it — whether it implements the MCP provider API is.
      const supported = detectCapabilities().hasLmMcpProvider;
      entries.push({
        target,
        enabled,
        ...agentRowLabels({
          target,
          presence: supported ? 'this-editor' : 'needs-attention',
          connected: enabled,
          ...(supported
            ? {}
            : {
                attentionDetail:
                  'This editor does not provide the VS Code MCP API, so FortMesa cannot register itself here. Its other agents are unaffected.',
              }),
        }),
      });
      continue;
    }

    try {
      const detected = await FILE_PROJECTOR_DETECTORS[target].detect();
      entries.push({
        target,
        enabled,
        ...agentRowLabels({ target, presence: detected ? 'installed' : 'not-installed', connected: enabled }),
      });
    } catch (error) {
      entries.push({
        target,
        enabled,
        ...agentRowLabels({
          target,
          presence: 'needs-attention',
          connected: enabled,
          attentionDetail: `Saferoom could not check this machine for it: ${errorMessage(error)}`,
        }),
      });
    }
  }

  return entries;
}

/**
 * The three documents tools are EXCLUDED from the general Tools table and
 * rendered in their own "Documents" table instead (PO, 2026-09-10), because a
 * single row per name could not express that two different implementations
 * answer to it. Their rows and descriptions come from
 * `registry/documents-mode.ts`, by ACTIVE MODE — never from the live fetch,
 * which reports only whichever side is currently exposed.
 */
function withoutDocumentsTools(tools: readonly ToolEntry[]): ToolEntry[] {
  return tools.filter((tool) => !isDocumentsToolName(tool.name));
}

/** Live-fetch the active environment's advertised tool set for the Tools section's checkbox list, MINUS the three documents tools (they have their own table, driven by the documents mode rather than by this fetch). Never throws — degrades to an empty list plus `toolsFetchError` on any failure (no credentials, unreachable gateway), so the rest of the panel still renders. */
async function fetchAllTools(config: Config, clientVersion: string): Promise<{ tools: ToolEntry[]; error?: string }> {
  const env = config.activeEnv;
  const gatewayUrlStr = config.environments[env]?.gateway;
  if (gatewayUrlStr === undefined) {
    return { tools: [], error: `No gateway configured for "${env}".` };
  }

  let client: Client;
  try {
    const creds = await resolveCredentials(env);
    client = await connectGateway(new URL(gatewayUrlStr), creds.token, clientVersion);
  } catch (error) {
    return { tools: [], error: `Could not reach the gateway for "${env}": ${errorMessage(error)}` };
  }

  try {
    const result = await client.listTools();
    const gatewayTools = result.tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
    return { tools: withoutDocumentsTools(gatewayTools) };
  } catch (error) {
    return { tools: [], error: `Could not list tools for "${env}": ${errorMessage(error)}` };
  } finally {
    await client.close();
  }
}

function scopeSummaryFor(scopeLock: Config['scopeLock']): string {
  if (scopeLock.mode === 'unlocked') return 'All scopes accessible';
  if (scopeLock.scopes.length === 0) return 'No scopes accessible';
  return scopeLock.scopes.join(', ');
}

/**
 * The Identity table's rows. Replaces the single crammed
 * "Signed in as X (y@z / provider) — env (expires <stamp>)" line the PO
 * called a "string smush": one labelled field per fact, so nothing has to be
 * parsed out of a sentence. Absent facts are simply omitted rather than
 * rendered as "unknown" noise — except the expiry, where "unknown" is itself
 * the meaningful state.
 */
async function identityFieldsFor(env: string): Promise<IdentityField[]> {
  const envLabel = environmentLabel(env);

  let token: string | undefined;
  try {
    token = await readCurrentToken(env);
  } catch (error) {
    return [
      { label: 'Status', value: `Could not read credentials: ${errorMessage(error)}` },
      { label: 'Data region', value: envLabel },
    ];
  }
  if (token === undefined) {
    return [
      { label: 'Status', value: 'Not signed in' },
      { label: 'Data region', value: envLabel },
    ];
  }

  // Best-effort enrichment with the real signed-in user (MFDV-244, shared
  // with the Account tree panel). `/api/v2/me` is live in next and prod
  // (verified 2026-09-07: 401 without a bearer, not 404 -- the route exists);
  // this degrades silently to the token-only fields below on any failure
  // (unreachable, missing/expired creds, or an environment without the
  // route at all).
  let identity: Identity | undefined;
  try {
    const creds = await resolveCredentials(env);
    identity = await fetchIdentity(creds.baseUrl, creds.token);
  } catch {
    identity = undefined;
  }

  const expiry = decodeJwtExpiry(token);
  const sub = decodeJwtSubject(token);
  const provider = identity?.identityProvider;

  return [
    { label: 'Status', value: 'Signed in' },
    ...(identity !== undefined
      ? [
          { label: 'User', value: identityPrimaryLabel(identity) },
          { label: 'Email', value: identity.email },
          { label: 'User ID', value: identity.userId },
        ]
      : []),
    ...(provider !== undefined && provider.length > 0 ? [{ label: 'Identity provider', value: provider }] : []),
    ...(sub !== undefined ? [{ label: 'Token ID', value: sub }] : []),
    { label: 'Data region', value: envLabel },
    { label: 'Token expires', value: formatExactExpiry(expiry) },
    { label: 'Time remaining', value: formatRelativeExpiry(expiry) },
  ];
}

async function buildState(
  clientVersion: string,
  sections: readonly SettingsSectionView[],
): Promise<SaferoomSettingsState> {
  const config = await loadConfig();
  const { tools, error } = await fetchAllTools(config, clientVersion);
  return {
    activeEnv: config.activeEnv,
    // Built-ins MERGED with the servers the user added. This used to read
    // ENVIRONMENTS alone while tokenEnvironments below read config, so the
    // same panel disagreed with itself about which environments exist and an
    // added server appeared in one dropdown and not the other.
    environments: await Promise.all(
      mergeServerList(config.environments).map(async (entry) => {
        // Never let one unreadable region's state fail the whole panel: an
        // unknown state renders as the least-claiming chip.
        const credentialState = await readRegionCredentialState(entry.name).catch<RegionCredentialState>(() => 'none');
        return {
          name: entry.name,
          label: entry.label,
          advanced: entry.advanced,
          gateway: entry.gateway,
          // A custom server has no app host of its own, so the launcher falls
          // back to production, which is what appLaunchUrl already does.
          app: ENVIRONMENTS[entry.name]?.app ?? appLaunchUrl(entry.name),
          custom: entry.custom,
          credentialState,
          credentialChip: regionChipLabel(credentialState),
        };
      }),
    ),
    agents: await buildAgentEntries(config.ideSync),
    disabledTools: config.disabledTools,
    allTools: tools,
    documents: documentsSectionView(config.documentsMode),
    ...(error !== undefined ? { toolsFetchError: error } : {}),
    scopeSummary: scopeSummaryFor(config.scopeLock),
    identityFields: await identityFieldsFor(config.activeEnv),
    tokenEnvironments: environmentChoices(Object.keys(config.environments), config.activeEnv).map((choice) => ({
      ...choice,
      tokenUrl: accessTokenUrl(choice.name),
    })),
    sections,
  };
}

type InboundMessage =
  | { readonly type: 'getState' }
  | { readonly type: 'setEnv'; readonly env: string }
  | { readonly type: 'toggleIdeTarget'; readonly target: IdeSyncTarget; readonly enabled: boolean }
  | { readonly type: 'toggleTool'; readonly tool: string; readonly enabled: boolean }
  | { readonly type: 'submitToken'; readonly env: string; readonly token: string; readonly apiBase?: string }
  | { readonly type: 'openTokenUi'; readonly env: string }
  | { readonly type: 'toggleSection'; readonly id: SettingsSectionId; readonly open: boolean }
  | { readonly type: 'setDocumentsMode'; readonly mode: string }
  | { readonly type: 'addServer'; readonly name: string; readonly gateway: string; readonly api?: string }
  | { readonly type: 'removeServer'; readonly name: string };

function isInboundMessage(value: unknown): value is InboundMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/**
 * A CSP nonce is a security token, so it must be unpredictable. This used to be a
 * non-cryptographic PRNG loop inherited from the VS Code webview sample, which is not
 * a CSPRNG. It matters because nonce-based CSP (no `'unsafe-inline'`) is the only thing
 * containing an injected attribute in these panels.
 */
function nonce(): string {
  return randomBytes(16).toString('base64');
}

function renderHtml(webview: vscode.Webview, cspNonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${cspNonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Settings</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border, transparent); padding-bottom: 4px; margin-top: 24px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .summary { color: var(--vscode-descriptionForeground); font-size: 12px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 6px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .env-preview { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; font-family: var(--vscode-editor-font-family, monospace); }
  .env-preview div { padding: 1px 0; }
  .agent-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; flex-wrap: wrap; }
  .agent-name { min-width: 130px; }
  .chip { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--vscode-widget-border, transparent); color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .chip.fortmesa.on { color: var(--vscode-charts-green, var(--vscode-foreground)); border-color: var(--vscode-charts-green, var(--vscode-widget-border, transparent)); }
  .chip.attention { color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border, transparent)); }
  .agent-hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
  button.link { background: transparent; color: var(--vscode-textLink-foreground); border: none; padding: 0 4px; font-size: 11px; cursor: pointer; text-decoration: underline; }
  details.advanced { margin-top: 10px; }
  details.advanced > summary { cursor: pointer; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
  .advanced-body { margin-top: 8px; max-width: 560px; font-size: 12px; }
  .advanced-body p { margin: 6px 0; line-height: 1.45; }
  label.field-label { display: block; margin: 8px 0 3px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .advanced-body input, .advanced-body select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font-family: inherit; font-size: 12px; }
  a { color: var(--vscode-textLink-foreground); }
  .region-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px; }
  .region-row .region-name { color: var(--vscode-descriptionForeground); }
  .region-row.active .region-name { color: var(--vscode-foreground); font-weight: 600; }
  .chip.credential.held { color: var(--vscode-charts-green, var(--vscode-foreground)); border-color: var(--vscode-charts-green, var(--vscode-widget-border, transparent)); }
  .chip.credential.stale { color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border, transparent)); }
  .status { margin-top: 8px; font-size: 12px; }
  .status.error { color: var(--vscode-errorForeground); }
  .status.ok { color: var(--vscode-charts-green, var(--vscode-foreground)); }
  [hidden] { display: none !important; }
  h3.subhead { font-size: 12px; font-weight: 600; margin: 18px 0 6px; }
  .mode-switch { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; }
  .mode-switch label { display: flex; align-items: center; gap: 5px; }
  .mode-preamble { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; margin: 6px 0 10px; max-width: 640px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { text-align: left; padding: 2px 8px 2px 0; vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  td.tool-name { white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); }
  td.tool-desc { color: var(--vscode-descriptionForeground); max-width: 1px; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table.identity { width: auto; }
  table.identity td.field { color: var(--vscode-descriptionForeground); white-space: nowrap; padding-right: 16px; }
  table.identity td.value { font-family: var(--vscode-editor-font-family, monospace); }
  button.icon-button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, transparent); opacity: 0.8; }
  button.icon-button:hover { background: var(--vscode-toolbar-hoverBackground, transparent); opacity: 1; }
  button.icon-button.on { opacity: 1; border-color: var(--vscode-focusBorder); }
  .error { color: var(--vscode-errorForeground); font-size: 12px; }
  label { cursor: pointer; }
  h2 button.disclosure { background: none; border: none; color: inherit; font: inherit; text-transform: inherit; letter-spacing: inherit; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; }
  h2 button.disclosure:hover { color: var(--vscode-foreground); }
  h2 button.disclosure:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .twisty { display: inline-block; transition: transform 100ms ease; }
  h2 button.disclosure[aria-expanded="false"] .twisty { transform: rotate(-90deg); }
</style>
</head>
<body>
  <!--
    Sections in the PO's 2026-09-08 order, each a disclosure. The two you
    OPERATE from this panel (Agents, Tools) are first and open; Scope and
    Identity are mirrored read-only here — their interactive surfaces are the
    sidebar and the Accessible scopes panel — so they lead nothing and start
    collapsed. A native <button> is the disclosure header precisely so Enter
    and Space already work, and so aria-expanded/aria-controls are ours to set
    rather than a <details> element's to imply.
  -->
  <section data-section="agents">
    <h2><button type="button" class="disclosure" data-toggle="agents" aria-expanded="true" aria-controls="body-agents"><span class="twisty" aria-hidden="true">\u25be</span>Agents</button></h2>
    <div class="section-body" id="body-agents">
      <div id="agents"></div>
    </div>
  </section>

  <section data-section="tools">
    <h2><button type="button" class="disclosure" data-toggle="tools" aria-expanded="true" aria-controls="body-tools"><span class="twisty" aria-hidden="true">\u25be</span>Tools</button></h2>
    <div class="section-body" id="body-tools">
      <div id="toolsError" class="error"></div>
      <table id="toolsTable">
        <thead><tr><th></th><th>Tool</th><th>Description</th></tr></thead>
        <tbody id="tools"></tbody>
      </table>

      <!--
        Documents is a SECOND table, not three more rows above (PO,
        2026-09-10). The same three names are implemented on both sides of the
        proxy, so a row per name in the general table could only ever describe
        one of them; the mode switch is what decides which, and the preamble
        says what that means before the rows are read.
      -->
      <h3 class="subhead">Documents</h3>
      <div class="mode-switch" id="documentsMode" role="radiogroup" aria-label="Documents tools mode"></div>
      <p class="mode-preamble" id="documentsPreamble"></p>
      <table id="documentsTable">
        <thead><tr><th></th><th>Tool</th><th>Description</th></tr></thead>
        <tbody id="documentsTools"></tbody>
      </table>
    </div>
  </section>

  <section data-section="dataRegion">
    <h2><button type="button" class="disclosure" data-toggle="dataRegion" aria-expanded="false" aria-controls="body-dataRegion"><span class="twisty" aria-hidden="true">\u25be</span>Data region</button></h2>
    <div class="section-body" id="body-dataRegion">
      <div class="row">
        <select id="envSelect"></select>
        <button id="envAdvanced" class="icon-button" title="Show all data regions and non-production environments">&#9881; Advanced</button>
      </div>
      <div class="region-list" id="regionList"></div>
      <div class="env-preview" id="envPreview"></div>
      <details class="advanced" id="addServer">
        <summary>Add a server</summary>
        <div class="advanced-body">
          <p>Point Saferoom at any FortMesa gateway. The name is yours to choose and is only a label.</p>
          <label class="field-label" for="serverName">Name</label>
          <input id="serverName" type="text" maxlength="${String(SERVER_NAME_MAX)}" placeholder="Acme EU" />
          <label class="field-label" for="serverGateway">Gateway URL</label>
          <input id="serverGateway" type="text" placeholder="https://mcp.example.com/mcp" />
          <label class="field-label" for="serverApi">API base (optional)</label>
          <input id="serverApi" type="text" placeholder="https://api.example.com" />
          <div class="row">
            <button id="serverAdd">Add server</button>
          </div>
        </div>
      </details>
    </div>
  </section>

  <section data-section="identity">
    <h2><button type="button" class="disclosure" data-toggle="identity" aria-expanded="false" aria-controls="body-identity"><span class="twisty" aria-hidden="true">\u25be</span>Identity</button></h2>
    <div class="section-body" id="body-identity">
      <table class="identity">
        <tbody id="identityFields"></tbody>
      </table>

      <details class="advanced" id="advanced">
        <summary>Advanced: paste an access token</summary>
        <div class="advanced-body">
          <p>Signing in is the recommended route &mdash; it uses a consent flow and issues short-lived session credentials.</p>
          <p>Access tokens are supported for machine-to-machine use and can be pinned for up to a year. That longevity is the risk: a pasted token stays valid until it expires or is revoked, wherever it ends up.</p>
          <p><a href="#" id="createTokenLink">Create an access token &rarr;</a></p>

          <label class="field-label" for="tokenEnvSelect">Data region</label>
          <select id="tokenEnvSelect"></select>

          <label class="field-label" for="tokenInput">Access token</label>
          <input type="password" id="tokenInput" placeholder="eyJhbGciOi&hellip;" autocomplete="off" spellcheck="false" />

          <div id="apiBaseRow" hidden>
            <label class="field-label" for="apiBaseInput">API base URL</label>
            <input type="text" id="apiBaseInput" placeholder="https://api.fortmesa.com" autocomplete="off" spellcheck="false" />
          </div>

          <div class="row"><button id="submitToken">Save access token</button></div>
          <div id="submitStatus" class="status"></div>
        </div>
      </details>
    </div>
  </section>

  <section data-section="scope">
    <h2><button type="button" class="disclosure" data-toggle="scope" aria-expanded="false" aria-controls="body-scope"><span class="twisty" aria-hidden="true">\u25be</span>Scope</button></h2>
    <div class="section-body" id="body-scope">
      <div id="scopeSummary" class="summary"></div>
    </div>
  </section>

<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  let lastState = null;

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function truncate(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // The Data region dropdown lists ONLY the production region until the user
  // opens "Advanced" (PO, 2026-09-03). It also opens itself when the active
  // environment is already an advanced one -- otherwise the control would be
  // unable to show what is actually in effect.
  let showAdvanced = false;

  function visibleEnvironments(state) {
    return showAdvanced ? state.environments : state.environments.filter((e) => !e.advanced || e.name === state.activeEnv);
  }

  function updateEnvPreview() {
    if (!lastState) return;
    const selected = document.getElementById('envSelect').value;
    const entry = lastState.environments.find((e) => e.name === selected);
    const preview = document.getElementById('envPreview');
    preview.innerHTML = entry
      ? '<div>Gateway: ' + escapeHtml(entry.gateway) + '</div><div>App: ' + escapeHtml(entry.app) + '</div>'
      : '';
  }

  function renderEnvSelect(state) {
    const envSelect = document.getElementById('envSelect');
    envSelect.innerHTML = '';
    for (const env of visibleEnvironments(state)) {
      const opt = document.createElement('option');
      opt.value = env.name;
      opt.textContent = env.label;
      opt.selected = env.name === state.activeEnv;
      envSelect.appendChild(opt);
    }
    const advancedButton = document.getElementById('envAdvanced');
    advancedButton.classList.toggle('on', showAdvanced);
    renderRegionList(state);
    updateEnvPreview();
  }

  // One row per region the dropdown is currently offering, each with the
  // credential chip the host decided. This is what makes a token saved for a
  // NON-active region visible: before it, the only evidence a credential
  // existed anywhere was the one-shot save confirmation.
  function renderRegionList(state) {
    const list = document.getElementById('regionList');
    list.innerHTML = '';
    for (const env of visibleEnvironments(state)) {
      const held = env.credentialState === 'signed-in' || env.credentialState === 'token-saved';
      const row = document.createElement('div');
      row.className = 'region-row' + (env.name === state.activeEnv ? ' active' : '');
      row.innerHTML =
        '<span class="region-name">' + escapeHtml(env.label) + '</span>' +
        '<span class="chip credential ' + (held ? 'held' : env.credentialState === 'expired' ? 'stale' : '') +
        '">' + escapeHtml(env.credentialChip) + '</span>' +
        (env.name === state.activeEnv ? '<span class="chip">Active</span>' : '') +
        // Only a server the user added can be removed, and not while it is
        // active: activeEnv pointing at a missing environment throws on the
        // next startup.
        (env.custom && env.name !== state.activeEnv
          ? '<button class="icon-button region-remove" data-remove="' + escapeHtml(env.name) + '" title="Remove this server">&times;</button>'
          : '');
      list.appendChild(row);
    }
  }

  // Disclosure state comes from the host (registry/settings-sections.ts holds
  // the order and the defaults, and globalState holds the per-machine memory),
  // so this loop never decides what is open -- it only paints the answer.
  document.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      vscode.postMessage({ type: 'removeServer', name: removeBtn.getAttribute('data-remove') });
      return;
    }
    if (e.target.id === 'serverAdd') {
      vscode.postMessage({
        type: 'addServer',
        name: document.getElementById('serverName').value,
        gateway: document.getElementById('serverGateway').value,
        api: document.getElementById('serverApi').value,
      });
    }
  });

  function renderSections(state) {
    for (const section of state.sections) {
      const header = document.querySelector('[data-toggle="' + section.id + '"]');
      const body = document.getElementById('body-' + section.id);
      if (!header || !body) continue;
      header.setAttribute('aria-expanded', section.open ? 'true' : 'false');
      body.hidden = !section.open;
    }
  }

  for (const header of document.querySelectorAll('button.disclosure')) {
    // A native <button> already fires click for both Enter and Space, so
    // there is no keydown handler here and no keyboard path to get wrong.
    header.addEventListener('click', () => {
      const id = header.dataset.toggle;
      const open = header.getAttribute('aria-expanded') !== 'true';
      vscode.postMessage({ type: 'toggleSection', id: id, open: open });
    });
  }

  function render(state) {
    lastState = state;

    renderSections(state);
    if (state.environments.some((e) => e.advanced && e.name === state.activeEnv)) showAdvanced = true;
    renderEnvSelect(state);
    renderTokenEnvSelect(state);

    // Two chips per row, always the same two questions in the same order:
    // is the agent on this machine, and is FortMesa wired into it. The
    // words come from the host (registry/agent-status.ts) -- this loop
    // never invents a state name.
    const agents = document.getElementById('agents');
    agents.innerHTML = '';
    for (const agent of state.agents) {
      const row = document.createElement('div');
      row.className = 'agent-row';
      const id = 'agent-' + agent.target;
      const chips = agent.chips
        .map(
          (chip) =>
            '<span class="chip ' + chip.kind + (chip.label === 'Connected' ? ' on' : '') +
            '" title="' + escapeHtml(chip.tooltip) + '">' + escapeHtml(chip.label) + '</span>',
        )
        .join('');
      row.innerHTML =
        '<input type="checkbox" id="' + escapeHtml(id) + '"' + (agent.enabled ? ' checked' : '') + ' />' +
        '<label class="agent-name" for="' + escapeHtml(id) + '">' + escapeHtml(agent.name) + '</label>' +
        chips +
        (agent.canConnect ? '<button class="link" data-connect="1">Connect</button>' : '') +
        (agent.hint ? '<span class="agent-hint">' + escapeHtml(agent.hint) + '</span>' : '');
      row.querySelector('input').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'toggleIdeTarget', target: agent.target, enabled: e.target.checked });
      });
      const connectButton = row.querySelector('button[data-connect]');
      if (connectButton) {
        // The same projector write the checkbox performs -- one action, two
        // affordances, so "Not connected" is directly actionable.
        connectButton.addEventListener('click', () => {
          vscode.postMessage({ type: 'toggleIdeTarget', target: agent.target, enabled: true });
        });
      }
      agents.appendChild(row);
    }

    document.getElementById('toolsError').textContent = state.toolsFetchError || '';
    const disabled = new Set(state.disabledTools);
    const tools = document.getElementById('tools');
    tools.innerHTML = '';
    for (const tool of state.allTools) {
      const tr = document.createElement('tr');
      const id = 'tool-' + tool.name;
      const shortDesc = truncate(tool.description || '', 100);
      tr.innerHTML =
        '<td><input type="checkbox" id="' + escapeHtml(id) + '"' + (!disabled.has(tool.name) ? ' checked' : '') + ' /></td>' +
        '<td class="tool-name"><label for="' + escapeHtml(id) + '">' + escapeHtml(tool.name) + '</label></td>' +
        '<td class="tool-desc" title="' + escapeHtml(tool.description || '') + '">' + escapeHtml(shortDesc) + '</td>';
      tr.querySelector('input').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'toggleTool', tool: tool.name, enabled: e.target.checked });
      });
      tools.appendChild(tr);
    }

    // Documents: the switch DRIVES exposure, so the rows re-describe themselves
    // when it moves -- the host sends the active mode's descriptions.
    const modeSwitch = document.getElementById('documentsMode');
    modeSwitch.innerHTML = '';
    for (const option of state.documents.options) {
      const id = 'documents-mode-' + option.id;
      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.innerHTML =
        '<input type="radio" name="documentsMode" id="' + escapeHtml(id) + '" value="' + escapeHtml(option.id) + '"' +
        (state.documents.mode === option.id ? ' checked' : '') + ' />' +
        '<span>' + escapeHtml(option.label) + '</span>';
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) vscode.postMessage({ type: 'setDocumentsMode', mode: option.id });
      });
      modeSwitch.appendChild(label);
    }
    document.getElementById('documentsPreamble').textContent = state.documents.preamble;

    const documentsTools = document.getElementById('documentsTools');
    documentsTools.innerHTML = '';
    for (const tool of state.documents.rows) {
      const tr = document.createElement('tr');
      const id = 'tool-' + tool.name;
      tr.innerHTML =
        '<td><input type="checkbox" id="' + escapeHtml(id) + '"' + (!disabled.has(tool.name) ? ' checked' : '') + ' /></td>' +
        '<td class="tool-name"><label for="' + escapeHtml(id) + '">' + escapeHtml(tool.name) + '</label></td>' +
        '<td class="tool-desc" title="' + escapeHtml(tool.description) + '">' + escapeHtml(tool.description) + '</td>';
      tr.querySelector('input').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'toggleTool', tool: tool.name, enabled: e.target.checked });
      });
      documentsTools.appendChild(tr);
    }

    document.getElementById('scopeSummary').textContent = state.scopeSummary;

    const identityFields = document.getElementById('identityFields');
    identityFields.innerHTML = '';
    for (const field of state.identityFields) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="field">' + escapeHtml(field.label) + '</td>' +
        '<td class="value">' + escapeHtml(field.value) + '</td>';
      identityFields.appendChild(tr);
    }
  }

  // Atomic switch: selecting a region IS the switch, there is no Apply
  // button (PO, 2026-09-03: "switch is atomic (does not require switch CTA
  // button)"). The host answers with a fresh state, which re-renders this.
  document.getElementById('envSelect').addEventListener('change', () => {
    updateEnvPreview();
    const env = document.getElementById('envSelect').value;
    if (lastState && env !== lastState.activeEnv) {
      vscode.postMessage({ type: 'setEnv', env });
    }
  });

  document.getElementById('envAdvanced').addEventListener('click', () => {
    showAdvanced = !showAdvanced;
    if (lastState) renderEnvSelect(lastState);
  });

  // ── Identity > Advanced: paste an access token ────────────────────────
  // Moved here from the sidebar's Signed-in user view (PO, 2026-09-05).
  // The token string only ever travels webview -> host; nothing posts one
  // back down, and it is cleared from the DOM the moment it is saved.
  function selectedTokenEnv() {
    const select = document.getElementById('tokenEnvSelect');
    return select.value || (lastState ? lastState.activeEnv : '');
  }

  function renderTokenEnvSelect(state) {
    const select = document.getElementById('tokenEnvSelect');
    const previous = select.value;
    select.innerHTML = '';
    for (const choice of state.tokenEnvironments) {
      const opt = document.createElement('option');
      opt.value = choice.name;
      opt.textContent = choice.label + (choice.active ? ' (active)' : '');
      opt.selected = choice.name === (previous || state.activeEnv);
      select.appendChild(opt);
    }
    const entry = state.tokenEnvironments.find((c) => c.name === selectedTokenEnv());
    document.getElementById('createTokenLink').title = entry ? entry.tokenUrl : '';
  }

  document.getElementById('tokenEnvSelect').addEventListener('change', () => {
    if (lastState) renderTokenEnvSelect(lastState);
  });

  document.getElementById('createTokenLink').addEventListener('click', (event) => {
    event.preventDefault();
    vscode.postMessage({ type: 'openTokenUi', env: selectedTokenEnv() });
  });

  document.getElementById('submitToken').addEventListener('click', () => {
    const status = document.getElementById('submitStatus');
    const token = document.getElementById('tokenInput').value;
    if (!token.trim()) {
      status.className = 'status error';
      status.textContent = 'Paste an access token first.';
      return;
    }
    status.className = 'status';
    status.textContent = 'Validating\u2026';
    vscode.postMessage({
      type: 'submitToken',
      env: selectedTokenEnv(),
      token: token,
      apiBase: document.getElementById('apiBaseInput').value,
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'state') {
      render(message.payload);
      return;
    }
    if (message.type === 'submitResult') {
      const status = document.getElementById('submitStatus');
      status.className = 'status ' + (message.ok ? 'ok' : 'error');
      status.textContent = message.message;
      if (message.needsApiBase) {
        document.getElementById('apiBaseRow').hidden = false;
        document.getElementById('apiBaseInput').focus();
      }
      // A saved credential must not be invisible. Either the host switched
      // the active region to it (regionNote) or it is offering to
      // (offerSwitch) -- the reported defect was neither happening, leaving
      // the token on disk and every surface reading an empty prod.
      if (message.regionNote) {
        const note = document.createElement('div');
        note.textContent = message.regionNote;
        status.appendChild(document.createElement('br'));
        status.appendChild(note);
      }
      if (message.offerSwitch) {
        const wrap = document.createElement('div');
        const text = document.createElement('span');
        text.textContent = message.offerSwitch.notice + ' ';
        const button = document.createElement('button');
        button.className = 'link';
        button.id = 'switchRegion';
        button.textContent = 'Switch to ' + message.offerSwitch.label;
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'setEnv', env: message.offerSwitch.env });
        });
        wrap.appendChild(text);
        wrap.appendChild(button);
        status.appendChild(wrap);
      }
      if (message.ok) {
        // Never keep the pasted secret sitting in a DOM node once it is saved.
        document.getElementById('tokenInput').value = '';
        document.getElementById('apiBaseInput').value = '';
        document.getElementById('apiBaseRow').hidden = true;
        document.getElementById('advanced').open = false;
      }
    }
  });

  vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}

let activePanel: vscode.WebviewPanel | undefined;

/**
 * Per-machine section memory. `globalState` rather than `workspaceState`: which
 * sections a person keeps open is a property of how they work, not of the
 * repository they happen to have open.
 */
let sectionMemory: vscode.Memento | undefined;

function currentSections(): SettingsSectionView[] {
  return resolveSettingsSections(sectionMemory?.get(SETTINGS_SECTIONS_KEY));
}

async function postFreshState(panel: vscode.WebviewPanel, clientVersion: string, log: Logger): Promise<void> {
  try {
    const state = await buildState(clientVersion, currentSections());
    await panel.webview.postMessage({ type: 'state', payload: state });
  } catch (error) {
    log.error(`Saferoom Settings: failed to build state: ${errorMessage(error)}`);
  }
}

async function handleMessage(
  message: unknown,
  panel: vscode.WebviewPanel,
  repoRoot: string,
  clientVersion: string,
  log: Logger,
): Promise<void> {
  if (!isInboundMessage(message)) return;

  switch (message.type) {
    case 'getState':
      await postFreshState(panel, clientVersion, log);
      return;

    case 'setEnv': {
      const config = await loadConfig();
      if (!(message.env in config.environments) || message.env === config.activeEnv) return;
      await saveConfig({ ...config, activeEnv: message.env });
      log.info(`Saferoom Settings: switched active environment to "${message.env}"`);
      await postFreshState(panel, clientVersion, log);
      return;
    }

    // Every failure here is a message the user needs to read and act on, so
    // they go back to the panel rather than only to the log. normalizeCustomServer
    // owns the wording; nothing is re-phrased on the way out.
    case 'addServer': {
      try {
        const key = await addCustomServer({
          name: message.name,
          gateway: message.gateway,
          ...(message.api !== undefined && message.api.trim() !== '' ? { api: message.api } : {}),
        });
        log.info(`Saferoom Settings: added server "${key}"`);
        void vscode.window.showInformationMessage(
          `Added "${message.name.trim()}". Save a token or sign in to start using it.`,
        );
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'removeServer': {
      try {
        const removed = await removeCustomServer(message.name);
        if (removed) log.info(`Saferoom Settings: removed server "${message.name}"`);
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'toggleIdeTarget': {
      if (!IDE_SYNC_TARGETS.includes(message.target)) return;
      await setIdeSyncTarget(message.target, message.enabled, repoRoot, log);
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'toggleTool': {
      const config = await loadConfig();
      const nextDisabled = message.enabled
        ? config.disabledTools.filter((name) => name !== message.tool)
        : config.disabledTools.includes(message.tool)
          ? config.disabledTools
          : [...config.disabledTools, message.tool];
      await saveConfig({ ...config, disabledTools: nextDisabled });
      log.info(`Saferoom Settings: tool "${message.tool}" ${message.enabled ? 'enabled' : 'disabled'}`);
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'setDocumentsMode': {
      // Same store as the tool checkboxes (config.json). The proxy's config
      // watcher turns this write into a reload(), which re-reads the mode and
      // sends tools/list_changed -- so a connected agent's tool list follows
      // the switch without restarting anything.
      if (!isDocumentsMode(message.mode)) return;
      const config = await loadConfig();
      if (config.documentsMode === message.mode) return;
      await saveConfig({ ...config, documentsMode: message.mode });
      log.info(`Saferoom Settings: documents tools switched to ${documentsModeOption(message.mode).label}`);
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'openTokenUi':
      await vscode.env.openExternal(vscode.Uri.parse(accessTokenUrl(message.env)));
      return;

    case 'toggleSection': {
      if (!isSettingsSectionId(message.id) || typeof message.open !== 'boolean') return;
      await sectionMemory?.update(SETTINGS_SECTIONS_KEY, withSectionOpen(currentSections(), message.id, message.open));
      await postFreshState(panel, clientVersion, log);
      return;
    }

    case 'submitToken': {
      const result = await submitAccessToken(message.env, message.token, message.apiBase, clientVersion);
      if (result.ok) {
        // Deliberately logs the environment and expiry only — never the token.
        log.info(
          `Saferoom Settings: saved a validated access token for "${message.env}" (expires ${result.expiry.toISOString()})`,
        );
        if (result.regionNote !== undefined) {
          log.info(
            `Saferoom Settings: active data region is now "${message.env}" (it held the only usable credential)`,
          );
        }
        await panel.webview.postMessage({
          type: 'submitResult',
          ok: true,
          message: `Access token saved for "${environmentLabel(message.env)}" — expires ${result.expiry.toLocaleString()}.`,
          ...(result.regionNote !== undefined ? { regionNote: result.regionNote } : {}),
          ...(result.offerSwitchTo !== undefined ? { offerSwitch: result.offerSwitchTo } : {}),
        });
        await postFreshState(panel, clientVersion, log);
        return;
      }
      await panel.webview.postMessage({
        type: 'submitResult',
        ok: false,
        message: result.message,
        ...(result.needsApiBase === true ? { needsApiBase: true } : {}),
      });
      return;
    }
  }
}

/** Register `fortmesa.openSaferoomSettings`: opens the (singleton — re-reveals if already open) Saferoom Settings webview panel. */
export function registerSaferoomSettingsCommand(
  context: vscode.ExtensionContext,
  repoRoot: string,
  log: Logger,
  clientVersion: string,
): void {
  sectionMemory = context.globalState;
  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.openSaferoomSettings', () => {
      if (activePanel !== undefined) {
        activePanel.reveal();
        void postFreshState(activePanel, clientVersion, log);
        return;
      }

      const panel = vscode.window.createWebviewPanel('fortmesa.saferoomSettings', 'Settings', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      activePanel = panel;
      panel.webview.html = renderHtml(panel.webview, nonce());

      panel.webview.onDidReceiveMessage(
        (message: unknown) => {
          void handleMessage(message, panel, repoRoot, clientVersion, log).catch((error: unknown) => {
            log.error(`Saferoom Settings: message handling failed unexpectedly: ${errorMessage(error)}`);
          });
        },
        undefined,
        context.subscriptions,
      );

      panel.onDidDispose(
        () => {
          activePanel = undefined;
        },
        undefined,
        context.subscriptions,
      );

      log.info('fortmesa.openSaferoomSettings: opened the Saferoom Settings webview');
    }),
  );
}

/** Push a fresh state snapshot to the Saferoom Settings webview if it's currently open — called from `extension.ts`'s `applyConfig` so an external config.json change (CLI, hand-edit) keeps the panel in sync while it's open. No-op if the panel isn't open. */
export function refreshSaferoomSettingsIfOpen(clientVersion: string, log: Logger): void {
  if (activePanel === undefined) return;
  void postFreshState(activePanel, clientVersion, log);
}
