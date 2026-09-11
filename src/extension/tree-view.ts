import * as vscode from 'vscode';
import type { Client } from '@modelcontextprotocol/client';
import { resolveCredentials } from '../local-mcp/auth/token-provider.js';
import { connectGateway } from '../local-mcp/proxy.js';
import { loadConfig, type Config } from '../registry/config.js';
import { scopeRowPresentation, sortScopeRows } from '../registry/scope-display.js';
import { listAndCacheScopes } from '../registry/scope-resolve.js';
import { errorMessage } from './logger.js';

/**
 * The three Saferoom native views (UX-ROUND-2-PLAN.md W4/D-U1) were retitled
 * for the 2026-09-03 UX round to "Scope selector", "Signed-in user" and
 * "Resources". This module now provides TWO of them: "Signed-in user" became
 * a `WebviewView` (`identity-view.ts`) in the same round, because its inline
 * advanced token control and inline sign-out confirmation cannot be
 * expressed as tree items. The two here are separately-registered `TreeDataProvider`s (not one
 * tree with sections, as the pre-round-2 single "Saferoom" view had). Each
 * is a flat list of rows with no nested children — collapsibility/sections
 * added nothing once each view has a single, focused job.
 *
 * Both share `SaferoomItem`/`toTreeItem` for the leaf-rendering
 * boilerplate; each view's own module-level function does the real
 * live-data read (config.json, credentials.json, a live gateway probe for
 * Scopes) and degrades to an inline error/status row on failure — never a
 * toast, since these run on passive background refreshes (config-reload,
 * `fortmesa.refresh`), not user-triggered actions.
 */

export interface SaferoomItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly command?: { readonly command: string; readonly arguments?: unknown[] };
  readonly icon?: vscode.ThemeIcon;
  readonly contextValue?: string;
}

function toTreeItem(element: SaferoomItem): vscode.TreeItem {
  const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
  if (element.description !== undefined) {
    item.description = element.description;
  }
  if (element.tooltip !== undefined) {
    item.tooltip = element.tooltip;
  }
  if (element.command !== undefined) {
    item.command = {
      command: element.command.command,
      title: element.label,
      ...(element.command.arguments !== undefined ? { arguments: element.command.arguments } : {}),
    };
  }
  if (element.icon !== undefined) {
    item.iconPath = element.icon;
  }
  item.contextValue = element.contextValue ?? `fortmesa.item.${element.id}`;
  return item;
}

/** Base class for the three flat (no-nested-children) Saferoom tree providers — each subclass supplies its own `fetchRows()`. */
abstract class FlatSaferoomTreeProvider implements vscode.TreeDataProvider<SaferoomItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  getTreeItem(element: SaferoomItem): vscode.TreeItem {
    return toTreeItem(element);
  }

  getChildren(element?: SaferoomItem): SaferoomItem[] | Promise<SaferoomItem[]> {
    if (element !== undefined) return [];
    return this.fetchRows();
  }

  protected abstract fetchRows(): SaferoomItem[] | Promise<SaferoomItem[]>;
}

// ── Scopes (W5, D-U3) ────────────────────────────────────────────────────

/** Live scope rows for the active environment. Row click = `fortmesa.selectScope` (single-scope switch); the active scope(s) are marked. Degrades to a single inline status row (never a toast) on any failure — not-signed-in, unreachable gateway, empty scope list. */
async function fetchScopeRows(clientVersion: string): Promise<SaferoomItem[]> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    return [{ id: 'scopes.error', label: 'Failed to load config.json', description: errorMessage(error) }];
  }

  const env = config.activeEnv;
  const gatewayUrlStr = config.environments[env]?.gateway;
  if (gatewayUrlStr === undefined) {
    return [{ id: 'scopes.error', label: `No gateway configured for "${env}"` }];
  }

  let creds: Awaited<ReturnType<typeof resolveCredentials>>;
  try {
    creds = await resolveCredentials(env);
  } catch (error) {
    return [{ id: 'scopes.error', label: 'Not signed in', description: errorMessage(error) }];
  }

  let client: Client;
  try {
    client = await connectGateway(new URL(gatewayUrlStr), creds.token, clientVersion);
  } catch (error) {
    return [{ id: 'scopes.error', label: 'Could not connect to the gateway', description: errorMessage(error) }];
  }

  try {
    const entries = await listAndCacheScopes(env, client);
    if (entries.length === 0) {
      return [{ id: 'scopes.empty', label: 'No scopes reported by the gateway' }];
    }

    // Three distinguishable row states, not two -- and the decision is made
    // by `scopeRowPresentation`, a pure vscode-free function, so it is
    // unit-testable. That is deliberate: `unlocked` used to render EVERY row
    // with the same `circle-large-outline` and no description as a
    // locked-but-not-selected row, so "all scopes are reachable" and "this
    // scope is not the one you locked" were pixel-identical. That ambiguity
    // is what made removing the unlock confirmation unsafe (PO, 2026-09-03:
    // the icons make the state clear). This function is where the three
    // states are kept distinct, and where a test can see them --
    // `test/registry/scope-display.test.mjs`. Everything below is mechanical
    // translation into VS Code types.
    // Accessible rows first, then inaccessible, alphabetical within each
    // (PO, 2026-09-08). The ordering decision is `sortScopeRows`, a pure
    // function in `scope-display.ts`, for the same reason the presentation
    // decision lives there: nothing in this module can be unit-tested.
    const ordered = sortScopeRows(config.scopeLock.mode, config.scopeLock.scopes, entries);
    return ordered.map((entry) => {
      const row = scopeRowPresentation(config.scopeLock.mode, config.scopeLock.scopes, entry.name);
      return {
        id: `scopes.${entry.id}`,
        label: entry.name,
        ...(row.description !== undefined ? { description: row.description } : {}),
        tooltip: row.tooltip,
        command: { command: 'fortmesa.selectScope', arguments: [entry.name] },
        icon:
          row.iconColor !== undefined
            ? new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.iconColor))
            : new vscode.ThemeIcon(row.icon),
      };
    });
  } catch (error) {
    return [{ id: 'scopes.error', label: 'Could not fetch scopes', description: errorMessage(error) }];
  } finally {
    await client.close();
  }
}

export class ScopesTreeProvider extends FlatSaferoomTreeProvider {
  constructor(private readonly clientVersion: string) {
    super();
  }

  protected fetchRows(): Promise<SaferoomItem[]> {
    return fetchScopeRows(this.clientVersion);
  }
}

// ── Resources (W7, U10) ──────────────────────────────────────────────────

/** The FortMesa partner-facing web destinations surfaced in the Resources view (PO, 2026-09-03). Environment-independent by design — these are the same for every data region. */
const PARTNER_PORTAL_URL = 'https://partner.fortmesa.com/';
const KNOWLEDGE_URL = 'https://partner.fortmesa.com/knowledge';

/**
 * The "Resources" view (was "Saferoom"): the app launcher for the active
 * data region, the two partner-facing web destinations, and the Settings
 * webview.
 *
 * The three web rows all carry `link-external` (PO, 2026-09-05: "one is
 * semantic and 2 are external link .. they should either be all three
 * semantic or all three external link"). External-link is the half that was
 * already in the majority, and it is the honest signal: all three leave the
 * IDE for a browser, which is the fact a user needs before clicking.
 * "Settings" keeps `settings-gear` deliberately — it opens a webview INSIDE
 * the IDE and is not one of the three. The two partner links are fixed, environment-independent URLs, so
 * they go through VS Code's built-in `vscode.open` rather than earning a
 * command of their own. The sandbox app URL is Cloudflare-WARP-gated — noted
 * as a tooltip on that row only when the sandbox is the active environment.
 */
async function fetchSaferoomRows(): Promise<SaferoomItem[]> {
  let activeEnv: string | undefined;
  try {
    activeEnv = (await loadConfig()).activeEnv;
  } catch {
    activeEnv = undefined;
  }

  return [
    {
      id: 'saferoom.openApp',
      label: 'FortMesa App',
      icon: new vscode.ThemeIcon('link-external'),
      command: { command: 'fortmesa.openApp' },
      ...(activeEnv === 'sandbox'
        ? { tooltip: 'sandbox is Cloudflare-WARP-gated — connect WARP if the app does not load' }
        : {}),
    },
    {
      id: 'saferoom.partnerPortal',
      label: 'Partner Portal',
      icon: new vscode.ThemeIcon('link-external'),
      tooltip: PARTNER_PORTAL_URL,
      command: { command: 'vscode.open', arguments: [vscode.Uri.parse(PARTNER_PORTAL_URL)] },
    },
    {
      id: 'saferoom.knowledge',
      label: 'Knowledge & Support',
      icon: new vscode.ThemeIcon('link-external'),
      tooltip: KNOWLEDGE_URL,
      command: { command: 'vscode.open', arguments: [vscode.Uri.parse(KNOWLEDGE_URL)] },
    },
    {
      id: 'saferoom.openSettings',
      label: 'Settings',
      icon: new vscode.ThemeIcon('settings-gear'),
      command: { command: 'fortmesa.openSaferoomSettings' },
    },
  ];
}

export class SaferoomLauncherTreeProvider extends FlatSaferoomTreeProvider {
  protected fetchRows(): Promise<SaferoomItem[]> {
    return fetchSaferoomRows();
  }
}
