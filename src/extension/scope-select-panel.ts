import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { loadConfig, saveConfig, type Config } from '../registry/config.js';
import { environmentLabel } from '../registry/environments.js';
import { identityChangeNotice } from '../registry/identity-change.js';
import {
  projectScopeTable,
  sameSelection,
  type ScopeSelection,
  type ScopeTableEntry,
  type ScopeTableView,
} from '../registry/scope-table.js';
import {
  initialSyncState,
  syncTransition,
  SYNC_DEBOUNCE_MS,
  SYNC_QUIET_MS,
  type SyncEvent,
  type SyncState,
} from '../registry/scope-sync.js';
import { errorMessage, type Logger } from './logger.js';
import { onIdentityChanged } from '../registry/identity-events.js';
import { listScopesQuiet } from './scope-list.js';

/**
 * "Accessible scopes" — the primary-pane surface for choosing what the agent
 * may act on (`fortmesa.switchScopeExpert`).
 *
 * ## Round 5 (PO, 2026-09-08, after testing 0.7.4)
 *
 * **Apply and Cancel are gone.** *"we need to avoid the apply button which may
 * be scrolled offscreen … I think we should auto-apply but perhaps adopt a
 * sync approach. Similar to google's undo button."* Every edit now enters a
 * debounced, coalescing state machine that writes by itself; the safety net is
 * **Undo**, not a pre-commit review step. The machine is
 * `registry/scope-sync.ts` — pure, tested, and deliberately NOT in this
 * `vscode`-importing module, because nothing here is reachable by a test.
 *
 * **The timers live host-side, not in the webview.** The host is what owns
 * `saveConfig`, so it must be what decides when a write goes out; a webview
 * timer would make "at most one write in flight" a hope rather than a
 * guarantee. The webview posts intent (`edit`) and the host runs the machine.
 *
 * **`filter` is not an `edit`.** Round 4 folded the filter string into the
 * same `draft` message as the checkboxes. Under auto-apply that would make
 * typing in the filter box schedule a config write. They are separate messages
 * now, and only one of them touches the machine.
 *
 * **A mode toggle sits above the table**: "Selected scopes" / "Run unlocked".
 * In unlocked mode the table is HIDDEN, not disabled — a greyed-out grid of 40
 * checkboxes is a wall of noise stating something a one-line hint says better.
 *
 * **Zero accessible scopes is a valid saved state.** Round 4 blocked it. The
 * contract never did: `ScopeLock.lockedTo([])` denies every scope
 * (`shared/scope-lock.ts`), which is exactly what "the agent may act nowhere"
 * has to mean, and `registry/config.ts` already warns about it correctly.
 *
 * **Switching to unlocked KEEPS the named scopes on disk.** `scopeLock.scopes`
 * is documented as ignored under `mode: 'unlocked'`, and `scope-display.ts`
 * is explicitly hardened for a stale array ("a stale non-empty `scopes` array
 * left behind by a previous lock does not make an unlocked row look locked").
 * Keeping it means Run unlocked → Selected scopes round-trips the user's set
 * instead of silently discarding it.
 *
 * **The panel reloads when the identity changes** (`identity-events.ts`), which
 * it previously did not — see that module for the verified gap.
 *
 * The rows stay purely alphabetical here even though the sidebar groups
 * accessible-first (PO, explicitly) — a table row that jumps group as you tick
 * it cannot be used.
 *
 * Bridge contract (webview <-> extension host via `postMessage`):
 *   webview -> host:  { type: 'getState' }                        // open / refresh: refetches the gateway list
 *                     { type: 'edit', mode, scopes }              // ANY draft mutation; drives the machine
 *                     { type: 'filter', filter }                  // display only; never writes
 *                     { type: 'undo' } | { type: 'retry' }
 *   host -> webview:  { type: 'state', payload: ScopeSelectionState }
 * Every message is answered with a freshly projected state — never an
 * optimistic echo of the request. The scope list itself is CACHED per open
 * panel: `edit`/`filter` project against the cache, so keystroke-rate messages
 * never touch the gateway.
 */

interface ScopeSelectionState {
  readonly envLabel: string;
  readonly table: ScopeTableView;
  /**
   * The host's authoritative draft, in full.
   *
   * The webview cannot rebuild it from `table.rows`: those are FILTERED, so a
   * scope hidden by the filter box would silently drop out of the selection
   * the moment any state arrived. The draft round-trips whole.
   */
  readonly draft: ScopeSelection;
  readonly error?: string;
  /** One-line strip shown when the signed-in identity changed under the panel. */
  readonly notice?: string;
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

/** The saved choice, read off the on-disk `scopeLock` contract. `single` and `multi` are one idea to the user. */
function savedSelection(config: Config): ScopeSelection {
  return {
    mode: config.scopeLock.mode === 'unlocked' ? 'unlocked' : 'selected',
    scopes: [...config.scopeLock.scopes],
  };
}

/**
 * The on-disk `scopeLock` block for a choice.
 *
 * `scopes.length === 1 ? 'single' : 'multi'` — note the difference from round
 * 4's `length > 1 ? 'multi' : 'single'`, which mapped **zero** scopes to
 * `'single'` and so tripped `config.ts`'s *"mode is 'single' but scopes has 0
 * entrie(s) (expected exactly 1)"* warning on every startup. `'multi'` with
 * `[]` says exactly what it means. Existing configs are unaffected: 1 →
 * `single`, >=2 → `multi`, as before.
 */
function toScopeLock(selection: ScopeSelection): Config['scopeLock'] {
  const scopes = [...selection.scopes];
  if (selection.mode === 'unlocked') return { mode: 'unlocked', scopes };
  return { mode: scopes.length === 1 ? 'single' : 'multi', scopes };
}

/** Live state of one open panel: the cached gateway scope list, the draft, and the sync machine. */
interface PanelState {
  entries: ScopeTableEntry[];
  saved: ScopeSelection;
  draft: ScopeSelection;
  filter: string;
  envLabel: string;
  // These five are cleared as well as set, so they carry `| undefined`
  // explicitly rather than `?` — the tsconfig runs `exactOptionalPropertyTypes`.
  error: string | undefined;
  notice: string | undefined;
  sync: SyncState;
  /** The saved set as it was when the current burst began — what Undo restores. */
  undoBaseline: ScopeSelection | undefined;
  debounceTimer: NodeJS.Timeout | undefined;
  quietTimer: NodeJS.Timeout | undefined;
}

const panelStates = new WeakMap<vscode.WebviewPanel, PanelState>();

/**
 * Refetch the gateway scope list and re-read the saved selection.
 *
 * ⚠️ **It does not clobber an in-progress burst.** `saveConfig` itself
 * triggers `watchConfig` -> `applyConfig` -> `refreshScopeSelectionIfOpen`,
 * so this function runs as a *consequence of every write this panel makes*.
 * Resetting the draft unconditionally (round 4's behaviour, which was safe
 * because a write only ever happened on an explicit Apply) would discard any
 * click made during the ~2 s the write is out — failure mode (2) in
 * `scope-sync.ts`. So the draft is re-seeded from disk ONLY when the machine
 * is idle.
 */
async function reload(panel: vscode.WebviewPanel, clientVersion: string): Promise<PanelState> {
  const previous = panelStates.get(panel);
  const config = await loadConfig();
  const envLabel = environmentLabel(config.activeEnv);
  const result = await listScopesQuiet(config, clientVersion);

  const entries: ScopeTableEntry[] =
    result.entries === undefined ? [] : result.entries.map((entry) => ({ name: entry.name, id: entry.id }));
  const saved = savedSelection(config);
  const sync = previous?.sync ?? initialSyncState;
  const keepDraft = previous !== undefined && sync.phase !== 'idle';

  const state: PanelState = {
    ...(previous ?? {}),
    entries,
    saved,
    draft: keepDraft ? previous.draft : { mode: saved.mode, scopes: [...saved.scopes] },
    filter: previous?.filter ?? '',
    envLabel,
    sync,
    notice: previous?.notice,
    undoBaseline: previous?.undoBaseline,
    debounceTimer: previous?.debounceTimer,
    quietTimer: previous?.quietTimer,
    error: result.error,
  };
  panelStates.set(panel, state);
  return state;
}

function project(state: PanelState): ScopeSelectionState {
  return {
    envLabel: state.envLabel,
    table: projectScopeTable(state.entries, state.saved, state.draft, state.filter, state.sync),
    draft: { mode: state.draft.mode, scopes: [...state.draft.scopes] },
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.notice !== undefined ? { notice: state.notice } : {}),
  };
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
<title>Accessible scopes</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 16px; font-size: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border, transparent); padding-bottom: 4px; margin-top: 20px; }
  .count { color: var(--vscode-descriptionForeground); }
  .notice { color: var(--vscode-descriptionForeground); border-left: 2px solid var(--vscode-focusBorder); padding: 2px 0 2px 8px; margin: 8px 0; }
  .modes { display: inline-flex; margin: 10px 0 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; overflow: hidden; }
  .modes button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 14px; cursor: pointer; font: inherit; }
  .modes button[aria-checked="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .modes button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .hint { color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
  .headline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 10px 0 6px; }
  .headline .sync { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .sync .msg { color: var(--vscode-descriptionForeground); }
  .sync.error .msg { color: var(--vscode-errorForeground); }
  .linkish { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; }
  .linkish:hover { text-decoration: underline; }
  input[type="search"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font: inherit; min-width: 180px; }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border, transparent); padding: 4px 8px 4px 0; }
  td { padding: 3px 8px 3px 0; vertical-align: middle; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .scope-id { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
  .chip { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .chip.pending { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .error { color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); margin: 8px 0; }
  label { cursor: pointer; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h2>Accessible scopes</h2>
  <div id="region" class="count"></div>
  <div id="notice" class="notice" role="status" hidden></div>
  <div id="error" class="error" hidden></div>

  <div class="modes" id="modes" role="radiogroup" aria-label="Scope selection mode"></div>
  <p class="hint" id="modeHint"></p>

  <div id="empty" class="empty" hidden>No scopes for this data region.</div>

  <div class="headline" id="headline" hidden>
    <span class="count" id="count"></span>
    <button type="button" class="linkish" id="selectAll">Select all</button>
    <button type="button" class="linkish" id="clear">Clear</button>
    <input type="search" id="filter" placeholder="Filter scopes" hidden />
    <span class="sync" id="sync" hidden>
      <span class="msg" id="syncMsg"></span>
      <button type="button" class="linkish" id="syncAction" hidden></button>
    </span>
  </div>

  <table id="table" hidden>
    <thead>
      <tr>
        <th><input type="checkbox" id="bulk" aria-label="Select all scopes" /></th>
        <th>Scope</th>
        <th>Scope ID</th>
        <th>State</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let view = null;
  let draft = { mode: 'selected', scopes: [] };
  let lastIndex = null;

  // Every draft mutation goes through here, and nothing else drives the sync
  // machine. The filter box deliberately does NOT (see postFilter): typing a
  // filter must never schedule a config write.
  function postEdit() {
    vscode.postMessage({ type: 'edit', mode: draft.mode, scopes: draft.scopes });
  }

  function postFilter() {
    vscode.postMessage({ type: 'filter', filter: $('filter').value });
  }

  function setRow(name, on) {
    const has = draft.scopes.includes(name);
    if (on && !has) draft.scopes = draft.scopes.concat([name]);
    if (!on && has) draft.scopes = draft.scopes.filter((n) => n !== name);
  }

  function renderModes(state) {
    const modes = $('modes');
    modes.textContent = '';
    state.modeOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      // Roving tabindex: a radiogroup is ONE tab stop, and the arrow keys move
      // within it.
      button.tabIndex = option.selected ? 0 : -1;
      button.dataset.mode = option.value;
      button.dataset.index = String(index);
      button.textContent = option.label;
      button.addEventListener('click', () => { chooseMode(option.value); });
      button.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        const delta = keys[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        const options = state.modeOptions;
        const next = options[(index + delta + options.length) % options.length];
        chooseMode(next.value);
      });
      modes.appendChild(button);
    });
  }

  function chooseMode(mode) {
    if (!view || draft.mode === mode) return;
    draft.mode = mode;
    postEdit();
  }

  function render(state) {
    view = state.table;
    draft = { mode: state.draft.mode, scopes: state.draft.scopes.slice() };

    $('region').textContent = state.envLabel;
    $('notice').hidden = !state.notice;
    $('notice').textContent = state.notice || '';
    $('error').hidden = !state.error;
    $('error').textContent = state.error || '';

    renderModes(view);
    $('modeHint').textContent = view.modeHint;

    const showRows = view.showTable && !view.empty;
    $('empty').hidden = !(view.showTable && view.empty);
    $('table').hidden = !showRows;
    $('headline').hidden = !view.showTable;
    $('selectAll').hidden = !view.showBulk || !showRows;
    $('clear').hidden = !view.showBulk || !showRows;
    $('bulk').hidden = !view.showBulk;
    $('filter').hidden = !view.showFilter || !showRows;

    $('count').textContent = view.countLabel;
    $('bulk').checked = view.bulk === 'all';
    $('bulk').indeterminate = view.bulk === 'some';

    const sync = view.sync;
    $('sync').hidden = !sync.visible;
    $('sync').className = sync.tone === 'error' ? 'sync error' : 'sync';
    $('syncMsg').textContent = sync.message;
    $('syncAction').hidden = !sync.action;
    $('syncAction').textContent = sync.actionLabel || '';
    $('syncAction').dataset.action = sync.action || '';

    const body = $('rows');
    body.textContent = '';
    view.rows.forEach((row, index) => {
      const tr = document.createElement('tr');

      const tdBox = document.createElement('td');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = row.draftAccessible;
      box.id = 'scope-' + row.id;
      box.setAttribute('aria-label', row.name);
      box.addEventListener('click', (event) => {
        // Shift-click extends from the last row touched, the range gesture a
        // table checkbox list is expected to have. The anchor row's NEW value
        // is what the range is set to. One gesture, one coalesced write.
        if (event.shiftKey && lastIndex !== null) {
          const from = Math.min(lastIndex, index);
          const to = Math.max(lastIndex, index);
          for (let i = from; i <= to; i += 1) setRow(view.rows[i].name, box.checked);
        } else {
          setRow(row.name, box.checked);
        }
        lastIndex = index;
        postEdit();
      });
      tdBox.appendChild(box);

      const tdName = document.createElement('td');
      const label = document.createElement('label');
      label.setAttribute('for', box.id);
      label.textContent = row.name;
      tdName.appendChild(label);

      const tdId = document.createElement('td');
      tdId.className = 'scope-id';
      tdId.textContent = row.id;

      const tdChip = document.createElement('td');
      tdChip.className = row.pending ? 'chip pending' : 'chip';
      tdChip.textContent = row.chip;

      tr.appendChild(tdBox);
      tr.appendChild(tdName);
      tr.appendChild(tdId);
      tr.appendChild(tdChip);
      body.appendChild(tr);
    });
  }

  $('bulk').addEventListener('change', () => {
    if (!view) return;
    const on = $('bulk').checked;
    for (const row of view.rows) setRow(row.name, on);
    lastIndex = null;
    postEdit();
  });
  $('selectAll').addEventListener('click', () => {
    if (!view) return;
    for (const row of view.rows) setRow(row.name, true);
    postEdit();
  });
  $('clear').addEventListener('click', () => {
    if (!view) return;
    for (const row of view.rows) setRow(row.name, false);
    postEdit();
  });
  $('filter').addEventListener('input', () => { postFilter(); });

  $('syncAction').addEventListener('click', () => {
    const action = $('syncAction').dataset.action;
    if (action === 'undo' || action === 'retry') vscode.postMessage({ type: action });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'state') return;
    // The host owns the draft, so adopt what it sends rather than keeping a
    // local copy that has diverged -- and take it from payload.draft, never
    // from the table rows, which the filter box may have narrowed.
    render(message.payload);
  });

  vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}

let activePanel: vscode.WebviewPanel | undefined;

async function post(panel: vscode.WebviewPanel, state: PanelState): Promise<void> {
  await panel.webview.postMessage({ type: 'state', payload: project(state) });
}

async function postReloaded(panel: vscode.WebviewPanel, clientVersion: string, log: Logger): Promise<void> {
  try {
    await post(panel, await reload(panel, clientVersion));
  } catch (error) {
    log.error(`Accessible scopes: failed to build state: ${errorMessage(error)}`);
  }
}

function clearTimers(state: PanelState): void {
  if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer);
  if (state.quietTimer !== undefined) clearTimeout(state.quietTimer);
  state.debounceTimer = undefined;
  state.quietTimer = undefined;
}

/**
 * Run one transition of the sync machine and reconcile the real world with the
 * state it returns: timers, the write, the undo baseline, and a repaint.
 *
 * This is the ONLY place `saveConfig` is reached from in this module, which is
 * what makes "at most one write in flight, one write per burst" a property of
 * `scope-sync.ts` rather than a discipline spread over the message handler.
 */
async function dispatch(
  panel: vscode.WebviewPanel,
  event: SyncEvent,
  clientVersion: string,
  log: Logger,
): Promise<void> {
  const state = panelStates.get(panel);
  if (state === undefined) return;

  const step = syncTransition(state.sync, event);
  state.sync = step.state;

  if (step.captureBaseline) {
    state.undoBaseline = { mode: state.saved.mode, scopes: [...state.saved.scopes] };
  }
  if (step.restoreBaseline && state.undoBaseline !== undefined) {
    state.draft = { mode: state.undoBaseline.mode, scopes: [...state.undoBaseline.scopes] };
  }

  // Timers follow the machine rather than the message: exactly one debounce
  // timer exists, and it is re-armed (not stacked) by every edit.
  if (state.debounceTimer !== undefined) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = undefined;
  }
  if (state.sync.debounceArmed) {
    state.debounceTimer = setTimeout(() => {
      void dispatch(panel, { type: 'debounceElapsed' }, clientVersion, log).catch((error: unknown) => {
        log.error(`Accessible scopes: debounce dispatch failed: ${errorMessage(error)}`);
      });
    }, SYNC_DEBOUNCE_MS);
  }

  if (state.quietTimer !== undefined) {
    clearTimeout(state.quietTimer);
    state.quietTimer = undefined;
  }
  if (state.sync.phase === 'saved') {
    state.quietTimer = setTimeout(() => {
      void dispatch(panel, { type: 'quietElapsed' }, clientVersion, log).catch((error: unknown) => {
        log.error(`Accessible scopes: quiet dispatch failed: ${errorMessage(error)}`);
      });
    }, SYNC_QUIET_MS);
  }

  await post(panel, state);

  if (step.startWrite) await performWrite(panel, clientVersion, log);
}

/**
 * Write the current draft, then feed the outcome back into the machine.
 *
 * The draft is SNAPSHOT before the await: an edit landing mid-write moves the
 * machine to `pending` and re-arms the timer, and this call must still record
 * what it actually wrote as `saved` — not what the draft became afterwards.
 */
async function performWrite(panel: vscode.WebviewPanel, clientVersion: string, log: Logger): Promise<void> {
  const state = panelStates.get(panel);
  if (state === undefined) return;

  const written: ScopeSelection = { mode: state.draft.mode, scopes: [...state.draft.scopes] };
  try {
    const config = await loadConfig();
    await saveConfig({ ...config, scopeLock: toScopeLock(written) });
    state.saved = written;
    log.info(
      `fortmesa.switchScopeExpert: accessible scopes saved as ${written.mode} ` +
        `[${written.scopes.join(', ')}] (${toScopeLock(written).mode})`,
    );
    await dispatch(panel, { type: 'writeOk' }, clientVersion, log);
  } catch (error) {
    log.error(`Accessible scopes: could not save the accessible scopes: ${errorMessage(error)}`);
    await dispatch(panel, { type: 'writeFailed' }, clientVersion, log);
  }
}

interface EditMessage {
  readonly type: 'edit';
  readonly mode: 'selected' | 'unlocked';
  readonly scopes: readonly string[];
}

function isEditMessage(value: unknown): value is EditMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'edit' &&
    'mode' in value &&
    (value.mode === 'selected' || value.mode === 'unlocked') &&
    'scopes' in value &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string')
  );
}

async function handleMessage(
  message: unknown,
  panel: vscode.WebviewPanel,
  clientVersion: string,
  log: Logger,
): Promise<void> {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;

  if (message.type === 'getState') {
    await postReloaded(panel, clientVersion, log);
    return;
  }

  const state = panelStates.get(panel);
  if (state === undefined) {
    await postReloaded(panel, clientVersion, log);
    return;
  }

  // Display-only. Deliberately not an `edit`: typing in the filter box must
  // never schedule a config write.
  if (message.type === 'filter') {
    state.filter = 'filter' in message && typeof message.filter === 'string' ? message.filter : '';
    await post(panel, state);
    return;
  }

  if (message.type === 'undo' || message.type === 'retry') {
    await dispatch(panel, { type: message.type }, clientVersion, log);
    return;
  }

  if (!isEditMessage(message)) return;

  const next: ScopeSelection = { mode: message.mode, scopes: [...message.scopes] };
  // A message that changes nothing is not an edit — it must not start a burst
  // or re-arm the debounce. (The webview already guards the mode toggle; this
  // is the host-side half of the same rule.)
  if (sameSelection(next, state.draft)) return;
  state.draft = next;
  // The notice has been overtaken by the user acting on it.
  state.notice = undefined;
  await dispatch(panel, { type: 'edit' }, clientVersion, log);
}

/** Open (or re-reveal) the singleton Accessible scopes panel. Called by `fortmesa.switchScopeExpert`. */
export function openScopeSelectionPanel(context: vscode.ExtensionContext, clientVersion: string, log: Logger): void {
  if (activePanel !== undefined) {
    activePanel.reveal();
    void postReloaded(activePanel, clientVersion, log);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'fortmesa.scopeSelection',
    'Accessible scopes',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  activePanel = panel;
  panel.webview.html = renderHtml(panel.webview, nonce());

  panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      void handleMessage(message, panel, clientVersion, log).catch((error: unknown) => {
        log.error(`Accessible scopes: message handling failed unexpectedly: ${errorMessage(error)}`);
      });
    },
    undefined,
    context.subscriptions,
  );

  // The identity under the panel can change while it is open (sign-out,
  // "Use a different account", a pasted token). The scope list it is showing
  // belongs to the OLD identity at that point, so reload rather than leave a
  // stale grid on screen, and say why.
  const identitySubscription = onIdentityChanged((change) => {
    if (activePanel !== panel) return;
    const state = panelStates.get(panel);
    if (state !== undefined) {
      // An identity change invalidates the burst: the scopes it named belonged
      // to someone else.
      clearTimers(state);
      state.sync = initialSyncState;
      state.undoBaseline = undefined;
      state.notice = identityChangeNotice(change.kind, change.label);
    }
    void postReloaded(panel, clientVersion, log);
  });
  context.subscriptions.push(identitySubscription);

  panel.onDidDispose(
    () => {
      const state = panelStates.get(panel);
      if (state !== undefined) clearTimers(state);
      // Unsubscribe with the panel. `context.subscriptions` alone would only
      // release it at extension teardown, so reopening the panel would stack a
      // second (inert, but real) listener on every open.
      identitySubscription.dispose();
      activePanel = undefined;
    },
    undefined,
    context.subscriptions,
  );

  log.info('fortmesa.switchScopeExpert: opened the Accessible scopes panel');
}

/** Push a fresh snapshot to the Accessible scopes panel if it is open — called from `extension.ts`'s `applyConfig` so an external config.json change keeps it in sync. No-op when closed. */
export function refreshScopeSelectionIfOpen(clientVersion: string, log: Logger): void {
  if (activePanel === undefined) return;
  void postReloaded(activePanel, clientVersion, log);
}
