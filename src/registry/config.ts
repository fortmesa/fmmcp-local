import { watch as watchFile } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_ENV, ENVIRONMENTS, gatewayDefaults, isSelectableEnv } from './environments.js';
import { isCustomEntry, isSelectableServer, normalizeCustomServer, type CustomServerInput } from './custom-servers.js';
import { DEFAULT_DOCUMENTS_MODE } from './documents-mode.js';

/**
 * The canonical `~/.fmcode/config.json` registry (VSIX-PLAN.md §3.2).
 *
 * This is the sync backbone between the CLI, the Saferoom VSIX, and every
 * running proxy instance: active environment, scope lock, per-env gateway
 * overrides, per-IDE sync opt-outs, and log level. It is deliberately kept
 * free of `vscode` imports — the extension and the CLI both consume it.
 *
 * Precedence at proxy startup (see `resolveEffectiveStartup`): explicit CLI
 * flags > config.json > built-in defaults.
 */

const scopeLockModeSchema = z.enum(['single', 'multi', 'unlocked']);

const scopeLockSchema = z.object({
  mode: scopeLockModeSchema,
  scopes: z.array(z.string()),
});

const environmentEntrySchema = z.object({
  gateway: z.string().min(1),
  /**
   * Set on servers the user added through Settings. The three fields are all
   * optional so every config.json written before this feature still loads.
   *
   * `custom` is not decorative. A prod-only build ships prod alone and must
   * keep refusing a `next` entry left over from a dev install, while allowing
   * a server the user deliberately added. Without the marker the two are the
   * same thing: a name and a gateway URL.
   */
  api: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  custom: z.boolean().optional(),
});

const ideSyncSchema = z.object({
  claude: z.boolean(),
  vscode: z.boolean(),
  cursor: z.boolean(),
  codex: z.boolean(),
  antigravity: z.boolean(),
  /**
   * `.default(true)` — a config.json written before this target existed has no
   * `copilot` key, and a required field would fail schema validation and make
   * the whole file unloadable. Every NEW ideSync target must be added this way,
   * for the same reason `disabledTools` below carries a default.
   */
  copilot: z.boolean().default(true),
});

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const configSchema = z.object({
  version: z.literal(1),
  activeEnv: z.string().min(1),
  scopeLock: scopeLockSchema,
  environments: z.record(z.string(), environmentEntrySchema),
  ideSync: ideSyncSchema,
  logLevel: logLevelSchema,
  /**
   * Tool names hidden from `tools/list` and rejected on direct call
   * (UX-ROUND-2-PLAN.md W3, D-U4): global for this prototype (not
   * per-environment). `.default([])` — every tool enabled — so a
   * config.json written before this field existed keeps loading rather than
   * failing schema validation.
   */
  disabledTools: z.array(z.string()).default([]),
  /**
   * Which implementation of the `grc_documents_*` tools is exposed to agents
   * (`documents-mode.ts`): `local` = this extension's path-based file I/O,
   * `network` = the gateway's URL-based presigned-link tools. `.default()`
   * for the same reason as `disabledTools` above — a config.json written
   * before this field existed must keep loading — and the default is `local`,
   * which is the behaviour every release before 0.7.9 hard-coded.
   */
  documentsMode: z.enum(['local', 'network']).default(DEFAULT_DOCUMENTS_MODE),
});

export type Config = z.infer<typeof configSchema>;

const DEFAULT_CONFIG: Config = {
  version: 1,
  activeEnv: DEFAULT_ENV,
  scopeLock: { mode: 'unlocked', scopes: [] },
  environments: gatewayDefaults(),
  ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true, copilot: true },
  logLevel: 'info',
  disabledTools: [],
  documentsMode: DEFAULT_DOCUMENTS_MODE,
};

/**
 * Resolve the config directory. `FMCODE_DIR` overrides `~/.fmcode` so tests
 * can point at a temp directory — computed fresh on every call (not cached
 * at module load) so a test can set the env var before its first call.
 */
function configDir(): string {
  return process.env.FMCODE_DIR ?? join(homedir(), '.fmcode');
}

/** Absolute path to config.json under the (possibly overridden) config dir. */
export function getConfigPath(): string {
  return join(configDir(), 'config.json');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Parse+validate raw JSON text against the config schema. Throws with a zod-issue-list message on failure. */
function parseConfig(raw: string, path: string): Config {
  const parsed: unknown = JSON.parse(raw);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid config file at ${path}: ${issues}`);
  }
  return result.data;
}

/**
 * Load config.json, creating it with defaults if missing.
 *
 * Throws if the file exists but fails schema validation (message lists the
 * zod issues, matching auth/token-provider.ts's credentialsFileSchema style).
 */
export async function loadConfig(): Promise<Config> {
  const path = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      await saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    throw error;
  }

  return parseConfig(raw, path);
}

/**
 * Validate and atomically write config.json (write to `<path>.tmp` then
 * rename, so a concurrent watcher never observes a half-written file).
 *
 * Throws on invalid input — never writes invalid data.
 */
export async function saveConfig(config: Config): Promise<void> {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Refusing to save invalid config: ${issues}`);
  }

  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });

  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(result.data, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Watch config.json for changes and re-emit a validated `Config` on each
 * settled write.
 *
 * Watches the PARENT DIRECTORY rather than the file itself — editors and our
 * own `saveConfig` save atomically via rename, which `fs.watch` on the file
 * itself can miss (the watched inode goes away on rename). Events are
 * filtered to the config.json basename and debounced (~150ms) so a burst of
 * rename events collapses into one reload.
 *
 * Transient parse/validation errors (e.g. a reader catching a half-written
 * file despite the atomic rename, or a hand-edited typo) are reported via
 * `log()` and do NOT crash the process or invoke `onChange` — only a
 * successfully validated `Config` reaches the caller.
 */
export function watchConfig(onChange: (config: Config) => void, log: (msg: string) => void): { close(): void } {
  const path = getConfigPath();
  const dir = dirname(path);
  const filename = basename(path);

  let debounceHandle: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (error) {
      log(`config.json watch: could not read config after change, skipping reload: ${errorMessage(error)}`);
      return;
    }

    let config: Config;
    try {
      config = parseConfig(raw, path);
    } catch (error) {
      log(`config.json watch: transient parse/validation error, skipping reload: ${errorMessage(error)}`);
      return;
    }

    onChange(config);
  };

  const watcher = watchFile(dir, (_eventType, changedFilename) => {
    if (changedFilename !== filename) return;

    if (debounceHandle !== undefined) {
      clearTimeout(debounceHandle);
    }
    debounceHandle = setTimeout(() => {
      debounceHandle = undefined;
      void reload();
    }, 150);
  });

  // `fs.watch()` handles are ref'd by default, which would keep the Node
  // event loop — and therefore the whole proxy process — alive forever on
  // their own, on top of whatever else is (or isn't) still open. Unref'ing
  // here means this watcher can never itself be a reason the process fails to
  // exit; callers that want deterministic cleanup (clearing any in-flight
  // debounce timer, releasing the OS watch) should still call the returned
  // `close()` — see cli.ts's stdio-pipe-close shutdown handler, which does.
  watcher.unref();

  return {
    close(): void {
      if (debounceHandle !== undefined) {
        clearTimeout(debounceHandle);
        debounceHandle = undefined;
      }
      watcher.close();
    },
  };
}

/** Explicit startup overrides — mirrors the CLI's `--env`/`--gateway`/`--scope-lock` flags. */
export interface StartupFlags {
  readonly env?: string;
  readonly gateway?: string;
  /**
   * `undefined` = flag absent, defer to config.json's scope lock.
   * `[]` (or any array) = flag present, explicit lock (or explicit unlock if empty).
   */
  readonly scopeLockNames?: string[];
}

export interface EffectiveStartup {
  readonly env: string;
  readonly gatewayUrl: string;
  readonly scopeLockNames: string[];
  /**
   * Whether a scope lock is CONFIGURED — deliberately independent of
   * `scopeLockNames.length`.
   *
   * `mode` and `scopes` are two independent settings, so `mode: "single"` with
   * `scopes: []` is reachable (edit either one alone, in the settings UI or by
   * hand). Inferring lockedness from the array length made that state permit
   * every scope while the UI read "single (no scopes selected)" — a lock that
   * silently allows everything. Carrying the bit explicitly is what lets the
   * caller fail CLOSED on it.
   */
  readonly scopeLocked: boolean;
}

/**
 * Resolve the effective startup parameters from explicit flags + config.json,
 * per the precedence rule in VSIX-PLAN.md §3.2: flags > config.json > defaults
 * (defaults are baked into `config.json` itself via `loadConfig`, so by the
 * time a `Config` reaches here there is no further built-in fallback layer).
 *
 * `log` is used only for a non-fatal warning when `scopeLock.mode` is
 * "single" but `scopes` doesn't have exactly one entry — a malformed config
 * should never crash startup, just surface a warning.
 */
export function resolveEffectiveStartup(
  flags: StartupFlags,
  config: Config,
  log: (msg: string) => void,
): EffectiveStartup {
  const env = flags.env ?? config.activeEnv;

  // A prod-only build ships prod alone. A config.json carried over from an
  // earlier install can still name next/latest, and --env accepts anything,
  // so refuse here rather than quietly proxying to a gateway this build is
  // not supposed to be able to reach.
  // A user-added server is selectable in every build, including prod-only.
  // A leftover next/latest entry from an earlier dev install is not, which is
  // what this gate has always been for.
  if (!isSelectableServer(env, config.environments, isSelectableEnv)) {
    const shipped = Object.keys(ENVIRONMENTS).join(', ');
    const added = Object.keys(config.environments).filter((name) => isCustomEntry(config.environments[name]));
    const available = added.length > 0 ? `${shipped}, ${added.join(', ')}` : shipped;
    throw new Error(
      `Environment "${env}" is not available in this build. Available: [${available}]. ` +
        `Add it under Data region in Settings if you meant to reach a different server.`,
    );
  }

  const gatewayUrl = flags.gateway ?? config.environments[env]?.gateway;
  if (gatewayUrl === undefined) {
    const available = Object.keys(config.environments).join(', ');
    throw new Error(
      `No gateway configured for env "${env}": pass --gateway explicitly or add "${env}" to ` +
        `config.json's "environments" (available: [${available}]).`,
    );
  }

  const scopeLockNames = flags.scopeLockNames ?? deriveScopeLockNames(config.scopeLock, log);
  // Flag present => the flag decides (an empty flag array is an explicit
  // unlock, per StartupFlags' contract). Flag absent => the config's MODE
  // decides, never the length of its scopes array.
  const scopeLocked =
    flags.scopeLockNames === undefined ? config.scopeLock.mode !== 'unlocked' : scopeLockNames.length > 0;

  return { env, gatewayUrl, scopeLockNames, scopeLocked };
}

function deriveScopeLockNames(scopeLock: Config['scopeLock'], log: (msg: string) => void): string[] {
  if (scopeLock.mode === 'unlocked') {
    return [];
  }

  if (scopeLock.scopes.length === 0) {
    log(
      `config.json scopeLock.mode is "${scopeLock.mode}" but no scopes are selected — NO scope is ` +
        `accessible, so every scope is refused until one is selected (previously this state silently ` +
        `permitted all scopes).`,
    );
    return [];
  }

  if (scopeLock.mode === 'single' && scopeLock.scopes.length !== 1) {
    log(
      `config.json scopeLock.mode is "single" but scopes has ${String(scopeLock.scopes.length)} ` +
        `entrie(s) (expected exactly 1); using scopes as-is: [${scopeLock.scopes.join(', ')}]`,
    );
  }

  return scopeLock.scopes;
}

/**
 * Add a server the user typed in, and return the key it was stored under.
 *
 * Writes `config.json` only. The API base, when the user supplied one, is
 * recorded on the entry so a later token paste has a base to default to;
 * `credentials.json` is still written by the token flow, because that is where
 * the token and its base belong.
 *
 * Does NOT switch to the new server. Saving a credential is what adopts a
 * region (`region-identity.ts`), and adding one you cannot yet authenticate
 * against would leave every panel reading an environment with no token, which
 * is the defect that module exists for.
 */
export async function addCustomServer(input: CustomServerInput): Promise<string> {
  const config = await loadConfig();
  const { key, entry } = normalizeCustomServer(input, Object.keys(config.environments));
  await saveConfig({ ...config, environments: { ...config.environments, [key]: entry } });
  return key;
}

/**
 * Remove a server the user added. Returns false if there is nothing to remove.
 *
 * Refuses to remove a built-in, and refuses to remove the active one: leaving
 * `activeEnv` pointing at an environment that no longer exists makes the next
 * startup throw, and silently switching the user somewhere else is worse.
 */
export async function removeCustomServer(key: string): Promise<boolean> {
  const config = await loadConfig();
  const entry = config.environments[key];
  if (entry === undefined || !isCustomEntry(entry)) return false;
  if (key === config.activeEnv) {
    throw new Error(`"${key}" is the active data region. Switch to another one first, then remove it.`);
  }
  const remaining = Object.fromEntries(Object.entries(config.environments).filter(([name]) => name !== key));
  await saveConfig({ ...config, environments: remaining });
  return true;
}
