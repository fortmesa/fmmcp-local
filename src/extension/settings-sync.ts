import * as vscode from 'vscode';
import { loadConfig, saveConfig, watchConfig, type Config } from '../registry/config.js';
import { DEFAULT_DOCUMENTS_MODE } from '../registry/documents-mode.js';
import type { Logger } from './logger.js';
import { errorMessage } from './logger.js';

/**
 * Two-way reconciliation between VS Code's `fortmesa.*` settings and
 * `~/.fmcode/config.json` (VSIX-PLAN.md §3.2, curriculum 08 pitfall #10).
 *
 * Two independent triggers, each guarded by compare-before-write against the
 * *other* store's current, freshly-read value:
 *
 *   (a) `vscode.workspace.onDidChangeConfiguration('fortmesa')` fires ->
 *       read live settings, load `config.json`, and only `saveConfig()` if
 *       at least one shared-contract field actually differs.
 *   (b) `registry/config.js`'s `watchConfig()` fires (file changed on disk,
 *       by the CLI, a hand-edit, or this same module's own `saveConfig()`
 *       call from (a)) -> read live settings, and only call
 *       `config.update(...)` for the individual fields that actually differ
 *       from the new `config.json`.
 *
 * `configEquals` is the one pure predicate both directions call — see its
 * doc comment for the loop-termination argument.
 */

const CONFIG_SECTION = 'fortmesa';

/**
 * The shared-naming-contract fields, flattened into a plain (vscode-free)
 * shape so `configEquals` and the snapshot builders below are unit-testable
 * without a real `vscode.WorkspaceConfiguration`.
 */
export interface FortmesaSettingsSnapshot {
  readonly activeEnv: string;
  readonly environments: Config['environments'];
  readonly scopeLockMode: Config['scopeLock']['mode'];
  readonly scopeLockScopes: readonly string[];
  readonly ideSyncClaude: boolean;
  readonly ideSyncVscode: boolean;
  readonly ideSyncCursor: boolean;
  readonly ideSyncCodex: boolean;
  readonly ideSyncAntigravity: boolean;
  readonly ideSyncCopilot: boolean;
  readonly logLevel: Config['logLevel'];
  readonly disabledTools: readonly string[];
  readonly documentsMode: Config['documentsMode'];
}

/** Project a `Config` (the `config.json` shape) down to the shared snapshot shape. */
export function snapshotFromConfig(config: Config): FortmesaSettingsSnapshot {
  return {
    activeEnv: config.activeEnv,
    environments: config.environments,
    scopeLockMode: config.scopeLock.mode,
    scopeLockScopes: config.scopeLock.scopes,
    ideSyncClaude: config.ideSync.claude,
    ideSyncVscode: config.ideSync.vscode,
    ideSyncCursor: config.ideSync.cursor,
    ideSyncCodex: config.ideSync.codex,
    ideSyncAntigravity: config.ideSync.antigravity,
    ideSyncCopilot: config.ideSync.copilot,
    logLevel: config.logLevel,
    disabledTools: config.disabledTools,
    documentsMode: config.documentsMode,
  };
}

/** Inverse of `snapshotFromConfig`: rebuild a full `Config` from a snapshot (e.g. one just read from live VS Code settings). Always produces `version: 1` — the only version this schema currently supports. Lossy by construction if `Config`'s schema ever grows a field not also added to `FortmesaSettingsSnapshot` — see `test/registry/settings-sync.test.mjs`'s schema-coverage assertion, which fails loudly if that ever happens. */
export function configFromSnapshot(snapshot: FortmesaSettingsSnapshot): Config {
  return {
    version: 1,
    activeEnv: snapshot.activeEnv,
    scopeLock: { mode: snapshot.scopeLockMode, scopes: [...snapshot.scopeLockScopes] },
    environments: snapshot.environments,
    ideSync: {
      claude: snapshot.ideSyncClaude,
      vscode: snapshot.ideSyncVscode,
      cursor: snapshot.ideSyncCursor,
      codex: snapshot.ideSyncCodex,
      antigravity: snapshot.ideSyncAntigravity,
      copilot: snapshot.ideSyncCopilot,
    },
    logLevel: snapshot.logLevel,
    disabledTools: [...snapshot.disabledTools],
    documentsMode: snapshot.documentsMode,
  };
}

function environmentsEqual(a: Config['environments'], b: Config['environments']): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && a[key]?.gateway === b[key]?.gateway);
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Pure field-by-field comparison of the shared-naming-contract fields — the
 * one predicate BOTH reconciliation directions use as their loop guard.
 *
 * Loop-termination argument (traced manually — see the final implementation
 * report for the full trace): whichever direction fires, it always compares
 * against a freshly re-read copy of the *other* store (never a cached
 * value), and only writes when a real difference exists. The write it
 * performs makes the two stores equal for every field this function
 * inspects. That write triggers the *other* direction's watcher, which
 * re-reads both stores, finds them equal via this same predicate, and
 * performs no further write. Neither direction can re-trigger itself (a
 * settings `update()` cannot fire `watchConfig`, and a `saveConfig()` cannot
 * fire `onDidChangeConfiguration`), so the recursion depth is bounded at
 * exactly one reciprocal (silent) pass per genuine change — no cycle.
 */
export function configEquals(a: FortmesaSettingsSnapshot, b: FortmesaSettingsSnapshot): boolean {
  return (
    a.activeEnv === b.activeEnv &&
    environmentsEqual(a.environments, b.environments) &&
    a.scopeLockMode === b.scopeLockMode &&
    stringArraysEqual(a.scopeLockScopes, b.scopeLockScopes) &&
    a.ideSyncClaude === b.ideSyncClaude &&
    a.ideSyncVscode === b.ideSyncVscode &&
    a.ideSyncCursor === b.ideSyncCursor &&
    a.ideSyncCodex === b.ideSyncCodex &&
    a.ideSyncAntigravity === b.ideSyncAntigravity &&
    a.ideSyncCopilot === b.ideSyncCopilot &&
    a.logLevel === b.logLevel &&
    stringArraysEqual(a.disabledTools, b.disabledTools) &&
    a.documentsMode === b.documentsMode
  );
}

function readVscodeSettings(): FortmesaSettingsSnapshot {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    activeEnv: settings.get<string>('activeEnv', 'sandbox'),
    environments: settings.get<Config['environments']>('environments', {}),
    scopeLockMode: settings.get<Config['scopeLock']['mode']>('scopeLock.mode', 'unlocked'),
    scopeLockScopes: settings.get<string[]>('scopeLock.scopes', []),
    ideSyncClaude: settings.get<boolean>('ideSync.claude', true),
    ideSyncVscode: settings.get<boolean>('ideSync.vscode', true),
    ideSyncCursor: settings.get<boolean>('ideSync.cursor', true),
    ideSyncCodex: settings.get<boolean>('ideSync.codex', true),
    ideSyncAntigravity: settings.get<boolean>('ideSync.antigravity', true),
    ideSyncCopilot: settings.get<boolean>('ideSync.copilot', true),
    logLevel: settings.get<Config['logLevel']>('logLevel', 'info'),
    disabledTools: settings.get<string[]>('disabledTools', []),
    documentsMode: settings.get<Config['documentsMode']>('documentsMode', DEFAULT_DOCUMENTS_MODE),
  };
}

// `Config['scopeLock']['mode']` and `Config['logLevel']` are both string
// literal unions — already covered by the `string` constituent below, so
// they're deliberately not repeated here (typescript-eslint's
// `no-redundant-type-constituents` rejects listing both).
type SettingsUpdateValue = string | boolean | string[] | Config['environments'];

interface SettingsUpdate {
  readonly key: string;
  readonly value: SettingsUpdateValue;
}

/** Build the list of individual `fortmesa.*` settings keys that differ from `config.json` — i.e. exactly the ones direction (b) needs to `update()`. Exported for unit testing without a real `WorkspaceConfiguration`. */
export function diffSettingsUpdates(
  currentSettings: FortmesaSettingsSnapshot,
  desired: FortmesaSettingsSnapshot,
): SettingsUpdate[] {
  const updates: SettingsUpdate[] = [];

  if (currentSettings.activeEnv !== desired.activeEnv) {
    updates.push({ key: 'activeEnv', value: desired.activeEnv });
  }
  if (!environmentsEqual(currentSettings.environments, desired.environments)) {
    updates.push({ key: 'environments', value: desired.environments });
  }
  if (currentSettings.scopeLockMode !== desired.scopeLockMode) {
    updates.push({ key: 'scopeLock.mode', value: desired.scopeLockMode });
  }
  if (!stringArraysEqual(currentSettings.scopeLockScopes, desired.scopeLockScopes)) {
    updates.push({ key: 'scopeLock.scopes', value: [...desired.scopeLockScopes] });
  }
  if (currentSettings.ideSyncClaude !== desired.ideSyncClaude) {
    updates.push({ key: 'ideSync.claude', value: desired.ideSyncClaude });
  }
  if (currentSettings.ideSyncVscode !== desired.ideSyncVscode) {
    updates.push({ key: 'ideSync.vscode', value: desired.ideSyncVscode });
  }
  if (currentSettings.ideSyncCursor !== desired.ideSyncCursor) {
    updates.push({ key: 'ideSync.cursor', value: desired.ideSyncCursor });
  }
  if (currentSettings.ideSyncCodex !== desired.ideSyncCodex) {
    updates.push({ key: 'ideSync.codex', value: desired.ideSyncCodex });
  }
  if (currentSettings.ideSyncAntigravity !== desired.ideSyncAntigravity) {
    updates.push({ key: 'ideSync.antigravity', value: desired.ideSyncAntigravity });
  }
  if (currentSettings.ideSyncCopilot !== desired.ideSyncCopilot) {
    updates.push({ key: 'ideSync.copilot', value: desired.ideSyncCopilot });
  }
  if (currentSettings.logLevel !== desired.logLevel) {
    updates.push({ key: 'logLevel', value: desired.logLevel });
  }
  if (!stringArraysEqual(currentSettings.disabledTools, desired.disabledTools)) {
    updates.push({ key: 'disabledTools', value: [...desired.disabledTools] });
  }
  if (currentSettings.documentsMode !== desired.documentsMode) {
    updates.push({ key: 'documentsMode', value: desired.documentsMode });
  }

  return updates;
}

/** Direction (b): `config.json` changed -> push only the differing fields into VS Code settings. */
async function reconcileConfigToSettings(config: Config, log: Logger): Promise<void> {
  const currentSettings = readVscodeSettings();
  const desired = snapshotFromConfig(config);
  const updates = diffSettingsUpdates(currentSettings, desired);

  if (updates.length === 0) {
    return;
  }

  const target = vscode.workspace.getConfiguration(CONFIG_SECTION);
  for (const update of updates) {
    await target.update(update.key, update.value, vscode.ConfigurationTarget.Global);
  }

  log.info(
    `settings reconciliation: config.json -> settings (${String(updates.length)} field(s): ` +
      `${updates.map((update) => update.key).join(', ')})`,
  );
}

/** Direction (a): VS Code settings changed -> write `config.json` only if the settings snapshot actually differs from it. */
async function reconcileSettingsToConfig(log: Logger): Promise<void> {
  const currentSettings = readVscodeSettings();

  let config: Config;
  try {
    config = await loadConfig();
  } catch (error) {
    log.error(`settings reconciliation: failed to load config.json, skipping: ${errorMessage(error)}`);
    return;
  }

  if (configEquals(currentSettings, snapshotFromConfig(config))) {
    return;
  }

  try {
    await saveConfig(configFromSnapshot(currentSettings));
  } catch (error) {
    log.error(
      `settings reconciliation: failed to save config.json, discarding settings change: ${errorMessage(error)}`,
    );
    return;
  }

  log.info('settings reconciliation: settings -> config.json (a fortmesa.* setting changed)');
}

export interface SettingsReconciliationHandle {
  dispose(): void;
}

/**
 * Start two-way settings <-> config.json reconciliation and run one initial
 * pass (config.json -> settings, config.json canonical per D-V4/D-V8) so a
 * freshly installed VSIX picks up any pre-existing CLI-managed config.json
 * immediately, without waiting for the first live change in either
 * direction.
 */
export function startSettingsReconciliation(
  context: vscode.ExtensionContext,
  log: Logger,
): SettingsReconciliationHandle {
  const configChangeSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG_SECTION)) return;
    void reconcileSettingsToConfig(log).catch((error: unknown) => {
      log.error(`settings reconciliation (settings -> config.json) failed unexpectedly: ${errorMessage(error)}`);
    });
  });
  context.subscriptions.push(configChangeSubscription);

  const fileWatcher = watchConfig(
    (config) => {
      void reconcileConfigToSettings(config, log).catch((error: unknown) => {
        log.error(`settings reconciliation (config.json -> settings) failed unexpectedly: ${errorMessage(error)}`);
      });
    },
    (msg) => {
      log.warn(msg);
    },
  );

  void loadConfig()
    .then((config) => reconcileConfigToSettings(config, log))
    .catch((error: unknown) => {
      log.error(`initial settings reconciliation failed: ${errorMessage(error)}`);
    });

  return {
    dispose(): void {
      fileWatcher.close();
    },
  };
}
