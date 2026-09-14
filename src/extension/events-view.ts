import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SIDEBAR_EVENT_LIMIT, FULLSCREEN_EVENT_LIMIT, type EventBus } from '../registry/events/event-bus.js';
import { toEventRows, type EventRow } from '../registry/events/event-row.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * The **Event viewer** — a live timeline of what the MCP is doing, in two
 * views painted by one renderer:
 *
 *  - `fortmesa.events`, a `WebviewView` sitting in the primary sidebar ABOVE
 *    the Signed-in user card, showing the last {@link SIDEBAR_EVENT_LIMIT}
 *    rows as one-line entries;
 *  - a `WebviewPanel` in the editor area (`fortmesa.openEventViewer`, the
 *    expand icon in the pane's title bar) showing the last
 *    {@link FULLSCREEN_EVENT_LIMIT} with two extra columns — the scope, and
 *    whether the call was served locally or relayed to the gateway.
 *
 * Both stream live off the same {@link EventBus}.
 *
 * ## What is deliberately NOT here
 *
 * No filters, no search, no export, no persistence. The PO asked for a
 * timeline that is readable at a glance and for the *seam* a log stream can
 * attach to later (`EventBus.subscribe`) — not for the log stream. Adding a
 * filter box is the change that turns this pane into a log viewer, and it
 * should be a decision someone makes on purpose.
 *
 * ## Privacy, restated at the render site
 *
 * Everything this module receives has already been reduced to a tool family,
 * a method, an outcome class, a duration and a short scope label
 * (`registry/events/summarize.ts`). There is no code path from a request or
 * response payload, a file path, a document title, an email or a token to
 * this webview — not because those are stripped here, but because they are
 * never carried into an `EventRecord` in the first place. If you find
 * yourself wanting to add a field to the row to make a row more informative,
 * check `summarize.ts`'s allowlist first: that is where the answer lives.
 *
 * Bridge contract (webview <-> host via `postMessage`):
 *   webview -> host: { type: 'ready' } | { type: 'expand' } | { type: 'clear' }
 *   host -> webview: { type: 'rows', payload: EventRow[] }
 */

/** How often the rows are re-posted so their relative times keep ageing. */
const TICK_MS = 15_000;

/** Coalescing window for a burst of events, so a parallel tool fan-out is one repaint. */
const COALESCE_MS = 120;

function nonce(): string {
  return randomBytes(16).toString('base64');
}

interface InboundMessage {
  readonly type: 'ready' | 'expand' | 'clear';
}

function isInboundMessage(value: unknown): value is InboundMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'ready' || value.type === 'expand' || value.type === 'clear')
  );
}

/**
 * The shared markup.
 *
 * `fullscreen` adds the scope and where columns and nothing else — same rows,
 * same colours, same glyphs, so a user reading the sidebar recognises the
 * expanded view immediately rather than learning a second layout.
 *
 * The narrow-sidebar constraint is carried by the CSS, not by truncating the
 * strings: the subject may wrap to a second line, and the trailing metadata
 * (duration, relative time) is pushed to the right and allowed to sit under
 * it. Nothing is ellipsised, because an ellipsised tool name is exactly as
 * useless as no tool name.
 */
function renderHtml(webview: vscode.Webview, cspNonce: string, fullscreen: boolean): string {
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
<title>Event viewer</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; padding: ${fullscreen ? '12px 16px' : '4px 8px 10px'}; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; padding: 2px 0; line-height: 1.45; border-bottom: 1px solid transparent; }
  li + li { border-top: 1px solid var(--vscode-widget-border, transparent); }
  .glyph { flex: 0 0 auto; width: 1em; text-align: center; }
  .ok .glyph { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .error .glyph { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
  .running .glyph { color: var(--vscode-charts-blue, var(--vscode-descriptionForeground)); }
  .subject { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .meta { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .chip { flex: 0 0 auto; padding: 0 5px; border-radius: 8px; font-size: 11px;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.err { background: var(--vscode-inputValidation-errorBackground, var(--vscode-badge-background));
              color: var(--vscode-errorForeground, var(--vscode-badge-foreground)); }
  .empty { color: var(--vscode-descriptionForeground); padding: 6px 0; line-height: 1.5; }
  .footer { margin-top: 10px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div id="empty" class="empty" hidden>Nothing yet. Tool calls and sign-ins appear here as they happen, for this editor session only.</div>
  <ul id="rows"></ul>
  ${fullscreen ? `<div class="footer">Last ${String(FULLSCREEN_EVENT_LIMIT)} events from this editor session. Not recorded anywhere — closing the window clears it.</div>` : ''}
<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  const FULLSCREEN = ${String(fullscreen)};

  function cell(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  function render(rows) {
    const list = document.getElementById('rows');
    document.getElementById('empty').hidden = rows.length > 0;
    list.textContent = '';
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = row.outcome;
      li.title = row.line;
      li.appendChild(cell('glyph', row.glyph));
      li.appendChild(cell('subject', row.subject));
      if (FULLSCREEN && row.scope) li.appendChild(cell('chip', row.scope));
      if (FULLSCREEN && row.where) li.appendChild(cell('chip', row.where));
      if (row.errorClass) li.appendChild(cell('chip err', row.errorClass));
      if (row.duration) li.appendChild(cell('meta', row.duration));
      li.appendChild(cell('meta', row.relative));
      list.appendChild(li);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'rows') render(message.payload);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * One webview's live subscription to the bus.
 *
 * Shared by the sidebar view and the fullscreen panel so the streaming rule
 * — coalesce a burst, re-post on a tick so times age, stop entirely when the
 * view goes away — exists once.
 */
function streamInto(
  webview: vscode.Webview,
  bus: EventBus,
  limit: number,
  log: Logger,
  onPost?: (count: number) => void,
): vscode.Disposable {
  let pending: NodeJS.Timeout | undefined;
  let disposed = false;

  const post = (): void => {
    if (disposed) return;
    const rows: EventRow[] = toEventRows(bus.snapshot(limit), limit);
    onPost?.(bus.size);
    void webview.postMessage({ type: 'rows', payload: rows }).then(undefined, (error: unknown) => {
      // A webview that went away between the schedule and the post is normal
      // (VS Code disposes hidden views), and is not worth an error line.
      log.debug(`Event viewer: could not post rows (${errorMessage(error)})`);
    });
  };

  const schedule = (): void => {
    if (disposed || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      post();
    }, COALESCE_MS);
  };

  const subscription = bus.subscribe(schedule);
  const tick = setInterval(post, TICK_MS);
  post();

  return {
    dispose: () => {
      disposed = true;
      subscription.dispose();
      clearInterval(tick);
      if (pending !== undefined) clearTimeout(pending);
    },
  };
}

/**
 * The sidebar pane (`fortmesa.events`).
 *
 * Its title-bar count is the view `description` — VS Code's own affordance
 * for a small trailing chip on a view header — rather than markup inside the
 * body, so it is legible while the section is COLLAPSED, which is the state
 * the chip is most useful in.
 */
export class EventsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private stream: vscode.Disposable | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml(webviewView.webview, nonce(), false);

    this.stream = streamInto(webviewView.webview, this.bus, SIDEBAR_EVENT_LIMIT, this.log, (count) => {
      // Empty rather than "0": a zero badge on a quiet session is noise.
      webviewView.description = count > 0 ? String(count) : '';
    });

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!isInboundMessage(message)) return;
      if (message.type === 'expand') void vscode.commands.executeCommand('fortmesa.openEventViewer');
      if (message.type === 'clear') this.bus.clear();
    });

    webviewView.onDidDispose(() => {
      this.stream?.dispose();
      this.stream = undefined;
      this.view = undefined;
    });
  }

  dispose(): void {
    this.stream?.dispose();
    this.stream = undefined;
    this.view = undefined;
  }
}

/**
 * The fullscreen view: a single reused editor-area panel.
 *
 * Singleton on purpose — "expand" is a zoom on one timeline, not a document
 * you open copies of, and two panels streaming the same bus would double the
 * repaint work for no new information.
 */
let panel: vscode.WebviewPanel | undefined;
let panelStream: vscode.Disposable | undefined;

export function registerEventViewerCommand(
  context: vscode.ExtensionContext,
  bus: EventBus,
  log: Logger,
): vscode.Disposable {
  const command = vscode.commands.registerCommand('fortmesa.openEventViewer', () => {
    if (panel !== undefined) {
      panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const created = vscode.window.createWebviewPanel(
      'fortmesa.eventViewer',
      'FortMesa Events',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    created.webview.html = renderHtml(created.webview, nonce(), true);
    panelStream = streamInto(created.webview, bus, FULLSCREEN_EVENT_LIMIT, log);
    created.webview.onDidReceiveMessage((message: unknown) => {
      if (isInboundMessage(message) && message.type === 'clear') bus.clear();
    });
    created.onDidDispose(() => {
      panelStream?.dispose();
      panelStream = undefined;
      panel = undefined;
    });
    panel = created;
  });
  context.subscriptions.push(command);
  context.subscriptions.push({
    dispose: () => {
      panelStream?.dispose();
      panelStream = undefined;
      panel?.dispose();
      panel = undefined;
    },
  });
  return command;
}
