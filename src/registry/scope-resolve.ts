import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { resolveScopeLock } from '../shared/scope-lock.js';
import type { AuthorizedScope } from '../shared/scope-lock.js';

/**
 * Scope-name → scopeId resolution and caching (VSIX-PLAN.md §3.4).
 *
 * Manual `scopeMap` maintenance in `~/.fmcode/credentials.json` is the
 * fallback path (see `resolveScopeLock`); this module is the auto-population
 * path used on env/scope switch: ask the gateway's `grc_scopes` tool for the
 * live name→id mapping, cache resolved names into the env's `scopeMap`, and
 * hand back the exact same `AuthorizedScope[]` shape the manual path returns.
 *
 * Deliberately free of `vscode` imports — shared by the CLI and the
 * extension (see src/registry/config.ts for the sibling canonical-config
 * module and its `FMCODE_DIR` override convention, mirrored here).
 */

/** Resolve the fmcode directory. `FMCODE_DIR` overrides `~/.fmcode` for tests. */
function credentialsDir(): string {
  return process.env.FMCODE_DIR ?? join(homedir(), '.fmcode');
}

/** Absolute path to credentials.json under the (possibly overridden) fmcode dir. */
function credentialsPath(): string {
  return join(credentialsDir(), 'credentials.json');
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read credentials.json as a loosely-typed JSON object (NOT schema-validated
 * away to a known shape) — this module only ever mutates the single
 * `environments.<env>.scopeMap` field, so every other field (known or
 * unknown to any schema) must survive round-tripping untouched.
 */
async function readCredentialsFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      throw new Error(
        `No credentials file found at ${path}. Sign in first — run \`fmmcp-local login\` ` +
          `(or "FortMesa: Sign In (OAuth)" in Saferoom); as an advanced fallback you can paste a ` +
          `token with \`fmmcp-local token set\`. Then retry resolving scopes.`,
        { cause: error },
      );
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid credentials file at ${path}: expected a JSON object`);
  }
  return parsed;
}

/** Atomic write (tmp + rename, matching src/registry/config.ts's saveConfig) + 0600 chmod. The tmp file is born 0600 (not the default umask) so there is no world-readable window before the post-rename chmod, which is kept regardless as belt-and-braces. */
async function writeCredentialsFile(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}

/** Validate an unknown value as a scope name → scopeId string map. `undefined` yields `{}`. */
function asScopeMap(value: unknown, context: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`Invalid credentials file: "${context}" must be an object of scope name -> scopeId strings`);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`Invalid credentials file: "${context}.${k}" must be a string scopeId`);
    }
    result[k] = v;
  }
  return result;
}

/**
 * Merge `additions` into env `env`'s `scopeMap` in `~/.fmcode/credentials.json`
 * (or `FMCODE_DIR` override) and persist the result.
 *
 * Surgical: every other field on the env block, every other environment, and
 * any fields unknown to this module's schema are preserved byte-for-byte
 * (the file is read as a plain JSON object and mutated in place, never
 * rebuilt from a stripped-down schema). Keeps all pre-existing scopeMap
 * entries not present in `additions`; on key conflict, `additions` wins.
 * The file is chmod'd 0600 after writing (it holds bearer tokens).
 *
 * Throws if the credentials file or the named environment doesn't exist yet
 * — there is no sensible default scopeMap to create one from scratch.
 */
export async function mergeScopeMap(env: string, additions: Record<string, string>): Promise<Record<string, string>> {
  const path = credentialsPath();
  const fileData = await readCredentialsFile(path);

  const environments = fileData.environments;
  if (!isRecord(environments)) {
    throw new Error(`Invalid credentials file at ${path}: missing "environments" object`);
  }

  const envBlock = environments[env];
  if (!isRecord(envBlock)) {
    const available = Object.keys(environments).join(', ');
    throw new Error(`Environment "${env}" not found in ${path}. Available: ${available}`);
  }

  const existingScopeMap = asScopeMap(envBlock.scopeMap, `environments.${env}.scopeMap`);
  const mergedScopeMap: Record<string, string> = { ...existingScopeMap, ...additions };

  envBlock.scopeMap = mergedScopeMap;
  await writeCredentialsFile(path, fileData);

  return mergedScopeMap;
}

/** Extract the first text-content string from a tool result, defensively (mirrors proxy.ts's filterScopesResult). */
function extractResultText(result: CallToolResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  return first.text;
}

/** A single `grc_scopes list` entry, as needed by both scope-name resolution and the Saferoom scope-switcher quickpicks. */
export interface ScopeListEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * Call the live gateway's `grc_scopes list` tool and return every
 * `{id, name}` entry it reports, in the gateway's own order. Shared by
 * `resolveAndCacheScopeMap` (below) and `listAndCacheScopes` (below) so the
 * "call the tool, validate the shape" logic exists in exactly one place —
 * also the same underlying call `cli.ts`'s `scopes list` subcommand and the
 * Saferoom `switchScope`/`switchScopeExpert` commands make.
 */
async function fetchScopeList(gatewayClient: Client, env: string): Promise<ScopeListEntry[]> {
  const result = await gatewayClient.callTool({
    name: 'grc_scopes',
    arguments: { method: 'list' },
  });

  const text = extractResultText(result);
  if (result.isError === true || text === undefined) {
    throw new Error(`grc_scopes list failed or returned an unexpected result shape for env "${env}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    throw new Error(`grc_scopes list returned invalid JSON for env "${env}": ${String(parseError)}`, {
      cause: parseError,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`grc_scopes list returned an unexpected result shape for env "${env}" (expected a JSON array).`);
  }

  const entries: ScopeListEntry[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const { id, name } = entry;
    if (typeof id === 'string' && typeof name === 'string') {
      entries.push({ id, name });
    }
  }
  return entries;
}

/**
 * List every scope the live gateway reports for `env` (via `fetchScopeList`)
 * and cache all of them into the env's `scopeMap` in credentials.json —
 * unlike `resolveAndCacheScopeMap`, this caches the FULL list, not just a
 * requested subset, and never throws on an "unmatched name" (there isn't
 * one). Used by `cli.ts`'s `scopes list` subcommand and by the Saferoom
 * `switchScope`/`switchScopeExpert` commands to populate their quickpicks
 * with live, current scope names.
 */
export async function listAndCacheScopes(env: string, gatewayClient: Client): Promise<ScopeListEntry[]> {
  const entries = await fetchScopeList(gatewayClient, env);

  const additions: Record<string, string> = {};
  for (const entry of entries) {
    additions[entry.name] = entry.id;
  }
  if (Object.keys(additions).length > 0) {
    await mergeScopeMap(env, additions);
  }

  return entries;
}

/**
 * Resolve `names` to `AuthorizedScope`s by calling the live gateway's
 * `grc_scopes list` tool, caching every successful name→id match into the
 * env's `scopeMap` (keyed by the ORIGINAL requested spelling, not the API's
 * casing), then delegating to `resolveScopeLock` so the return value is
 * identical in shape/behavior to the existing manual-scopeMap path.
 *
 * Matching is case-insensitive on both sides. Throws (after caching whatever
 * did resolve) if any requested name has no match, listing the unmatched
 * names and the live gateway's available names.
 */
export async function resolveAndCacheScopeMap(
  names: string[],
  env: string,
  gatewayClient: Client,
): Promise<AuthorizedScope[]> {
  const entries = await fetchScopeList(gatewayClient, env);

  const byLowerName = new Map<string, ScopeListEntry>();
  for (const entry of entries) {
    byLowerName.set(entry.name.toLowerCase(), entry);
  }

  const additions: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const requestedName of names) {
    const match = byLowerName.get(requestedName.toLowerCase());
    if (match === undefined) {
      unmatched.push(requestedName);
    } else {
      additions[requestedName] = match.id;
    }
  }

  // Cache every successful match even if others below fail to resolve —
  // partial progress on a scope-name typo shouldn't be discarded.
  const mergedScopeMap = await mergeScopeMap(env, additions);

  if (unmatched.length > 0) {
    const available = [...byLowerName.keys()].join(', ');
    throw new Error(
      `Scope name(s) not found via gateway grc_scopes for env "${env}": [${unmatched.join(', ')}]. ` +
        `Available scopes: [${available}]`,
    );
  }

  return resolveScopeLock(names, mergedScopeMap, env);
}
