import type { Client } from '@modelcontextprotocol/client';
import { resolveCredentials } from '../local-mcp/auth/token-provider.js';
import { connectGateway } from '../local-mcp/proxy.js';
import type { Config } from '../registry/config.js';
import { listAndCacheScopes, type ScopeListEntry } from '../registry/scope-resolve.js';
import { errorMessage } from './logger.js';

/**
 * A QUIET live scope-list read for the active environment: it returns its
 * failure as a value instead of raising a toast.
 *
 * The command-palette scope quickpicks this replaced reported failures with
 * `showErrorMessage`, because a quickpick has nowhere else to put the
 * message. The Scope selection panel has somewhere else — its own body — so
 * it needs the same probe without the popup. Being deliberately toast-free
 * is the point of this module; do not add `vscode.window` calls here.
 */
export async function listScopesQuiet(
  config: Config,
  clientVersion: string,
): Promise<{ entries: ScopeListEntry[]; error?: undefined } | { entries?: undefined; error: string }> {
  const env = config.activeEnv;
  const gatewayUrlStr = config.environments[env]?.gateway;
  if (gatewayUrlStr === undefined) {
    return { error: `No gateway configured for the active environment "${env}".` };
  }

  let creds: Awaited<ReturnType<typeof resolveCredentials>>;
  try {
    creds = await resolveCredentials(env);
  } catch (error) {
    return { error: `Not signed in for "${env}" (${errorMessage(error)}).` };
  }

  let client: Client;
  try {
    client = await connectGateway(new URL(gatewayUrlStr), creds.token, clientVersion);
  } catch (error) {
    return { error: `Could not connect to the gateway for "${env}" (${errorMessage(error)}).` };
  }

  try {
    return { entries: await listAndCacheScopes(env, client) };
  } catch (error) {
    return { error: `Could not fetch the scope list for "${env}" (${errorMessage(error)}).` };
  } finally {
    await client.close();
  }
}
