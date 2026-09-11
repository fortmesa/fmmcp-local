import { ENVIRONMENTS, requireSecureApiBase } from './environments.js';

/**
 * User-added servers.
 *
 * The four built-in environments are compiled in, and a prod build ships only
 * `prod`. That is deliberate and stays. What it prevented, until this module,
 * was pointing Saferoom at any other gateway without hand-editing
 * `config.json`, which no user is going to do.
 *
 * A custom server is an ordinary entry in `config.json`'s `environments` map
 * carrying `custom: true`. The marker is load-bearing rather than decorative.
 * A prod-only build must keep refusing a `next` entry left behind by an
 * earlier dev install, while accepting a server the user deliberately added,
 * and the two are otherwise indistinguishable: both are a name and a gateway
 * URL in the same map.
 *
 * `vscode`-free like the rest of `registry/`, and free of any config I/O, so
 * the rules here are testable as plain functions.
 */

/** What the user types. `api` is optional; a pasted token supplies the base when it is absent. */
export interface CustomServerInput {
  readonly name: string;
  readonly gateway: string;
  readonly api?: string;
}

/** An entry as it is stored in config.json's `environments` map. */
export interface CustomServerEntry {
  readonly gateway: string;
  readonly api?: string;
  readonly label: string;
  readonly custom: true;
}

/** One row of the Data region list, built-in or added. */
export interface ServerListEntry {
  readonly name: string;
  readonly label: string;
  readonly gateway: string;
  readonly api?: string;
  /** Hidden behind the "Advanced" affordance. Every non-production built-in is advanced; added servers are not. */
  readonly advanced: boolean;
  /** False for the compiled-in environments, which cannot be edited or removed. */
  readonly custom: boolean;
}

/** Longest display name accepted. Long enough for "Acme Production (EU)", short enough to render in a dropdown. */
export const SERVER_NAME_MAX = 40;

/**
 * Turn a display name into a config key.
 *
 * The key is the identity: `config.json`'s `activeEnv`, `credentials.json`'s
 * per-environment block and every projector key off it, so it has to survive
 * a round trip through a JSON object key and a CLI `--env` argument. The
 * display name does not, which is why both are stored.
 */
export function slugifyServerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True when this entry was added by the user rather than compiled in. */
export function isCustomEntry(entry: { custom?: boolean | undefined } | undefined): boolean {
  return entry?.custom === true;
}

/**
 * Validate one user-supplied server and return the key to store it under
 * along with the entry.
 *
 * Throws with a message meant for a person, since every one of these lands in
 * a webview toast. `existingNames` is checked here rather than by the caller
 * so the "name already used" rule cannot differ between the settings panel
 * and the CLI.
 */
export function normalizeCustomServer(
  input: CustomServerInput,
  existingNames: readonly string[] = [],
): { key: string; entry: CustomServerEntry } {
  const label = input.name.trim();
  if (label === '') throw new Error('Give the server a name.');
  if (label.length > SERVER_NAME_MAX) {
    throw new Error(`"${label}" is too long. Use ${String(SERVER_NAME_MAX)} characters or fewer.`);
  }

  const key = slugifyServerName(label);
  if (key === '') {
    throw new Error(`"${label}" has no letters or digits to build a name from. Try something like "Acme EU".`);
  }
  if (Object.hasOwn(ENVIRONMENTS, key)) {
    throw new Error(`"${label}" collides with the built-in environment "${key}". Pick another name.`);
  }
  if (existingNames.includes(key)) {
    throw new Error(`A server named "${label}" already exists. Pick another name, or remove that one first.`);
  }

  // requireSecureApiBase is the same https-or-loopback rule the advanced API
  // base control applies. It is reused rather than reimplemented: a custom
  // gateway is where a bearer token gets sent, so an http:// host would put
  // the token on the wire in cleartext exactly as an http:// API base would.
  const gateway = requireSecureApiBase(input.gateway);

  const entry: CustomServerEntry = {
    gateway,
    label,
    custom: true,
    ...(input.api !== undefined && input.api.trim() !== '' ? { api: requireSecureApiBase(input.api) } : {}),
  };
  return { key, entry };
}

/**
 * The Data region list: every built-in this build ships, then every added
 * server, in insertion order.
 *
 * Built from BOTH sources deliberately. The settings panel used to render
 * `ENVIRONMENTS` alone while the token control rendered `config.environments`,
 * so the same panel disagreed with itself about which environments exist and
 * an added server appeared in one dropdown and not the other.
 */
export function mergeServerList(
  configEnvironments: Readonly<
    Record<
      string,
      { gateway: string; api?: string | undefined; label?: string | undefined; custom?: boolean | undefined }
    >
  >,
): ServerListEntry[] {
  const rows: ServerListEntry[] = [];

  for (const [name, builtin] of Object.entries(ENVIRONMENTS)) {
    rows.push({
      name,
      label: builtin.label,
      // config.json may override a built-in's gateway; that is long-standing
      // behaviour (resolveEffectiveStartup reads config, not ENVIRONMENTS).
      gateway: configEnvironments[name]?.gateway ?? builtin.gateway,
      api: builtin.api,
      advanced: builtin.advanced,
      custom: false,
    });
  }

  for (const [name, entry] of Object.entries(configEnvironments)) {
    if (Object.hasOwn(ENVIRONMENTS, name)) continue;
    if (!isCustomEntry(entry)) continue; // a stale non-prod leftover, not something the user added
    rows.push({
      name,
      label: entry.label ?? name,
      gateway: entry.gateway,
      ...(entry.api !== undefined ? { api: entry.api } : {}),
      advanced: false,
      custom: true,
    });
  }

  return rows;
}

/**
 * Whether `env` may be selected, given what this build ships and what the
 * user has added.
 *
 * A prod-only build ships prod alone, and a `config.json` carried over from a
 * dev install can still name next or latest. Those stay refused. A server the
 * user added in this build is allowed, in prod builds too, which is the whole
 * point of the feature.
 */
export function isSelectableServer(
  env: string,
  configEnvironments: Readonly<Record<string, { custom?: boolean | undefined }>>,
  isSelectableBuiltIn: (name: string) => boolean,
): boolean {
  return isSelectableBuiltIn(env) || isCustomEntry(configEnvironments[env]);
}
