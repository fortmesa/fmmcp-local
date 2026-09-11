#!/usr/bin/env node
/**
 * hot-reload-test.mjs — Hot-reload E2E (VSIX-PLAN.md §4.3 / D-V10, §10.2).
 *
 * Proves that `src/local-mcp/proxy.ts`'s `reload()` actually changes LIVE
 * request-handling behavior — not just that a `tools/list_changed`
 * notification fires, which on its own would only prove the wiring exists.
 *
 * Flow:
 *   1. Boot the built proxy flag-less (`yarn node dist/local-mcp/cli.js`,
 *      no --env/--gateway/--scope-lock) against a temp `FMCODE_DIR` holding
 *      only a `config.json` (unlocked) + a `credentials.json` carrying the
 *      real sandbox token block.
 *   2. Confirm the full 16-tool surface (13 relayed + 3 local documents).
 *   3. Call `grc_scopes list` while unlocked and record the baseline count —
 *      this environment's real scope count, never hardcoded.
 *   4. Subscribe to `notifications/tools/list_changed` BEFORE mutating.
 *   5. Atomically flip config.json's `scopeLock` to `{ mode: "single",
 *      scopes: [<name>] }` for one real scope (resolved by NAME, since
 *      scope-lock.ts's resolveScopeLock matches by name, not id).
 *   6. Wait (bounded) for the reload notification.
 *   7. Call `grc_scopes list` again and assert the result is now filtered
 *      down to ONLY the locked scope. This last call is the actual proof —
 *      the notification alone doesn't show the lock took effect on live
 *      calls.
 *   8. (R2/F3) Call the LOCAL `grc_documents_read` tool naming the newly
 *      locked scope — must succeed — then naming a DIFFERENT known scope —
 *      must fail with the scope-lock `isError`. Proves the documents tools
 *      read the LIVE lock via `ConnectedProxy.getLock()`, not a stale
 *      startup-time capture.
 *   9. (R1/F1) Bad-gateway QUARANTINE: point `config.json`'s gateway at an
 *      unreachable address and confirm a subsequent tool call is REFUSED with
 *      an explicit isError, and stderr logged the failed reload as
 *      "QUARANTINED".
 *      This leg previously asserted the opposite — that calls still succeed on
 *      the OLD gateway/lock. That behaviour was the defect: the user has
 *      already moved on in the Saferoom UI, so continuing to serve the old
 *      binding leaves the agent holding access to the scope the user believes
 *      they left, with nothing anywhere saying so. The proxy now quarantines
 *      instead; step 10's first valid config write clears it.
 *  10. (R1/F2) Rapid double-write: two valid config states written back to
 *      back with no await/sleep between them; assert the FINAL live behavior
 *      matches only the LAST write, and the process is still healthy.
 *  11. (R7/F8) Env-switch: spawn a SECOND fmmcp-gw gateway on :3022 (same
 *      sandbox upstream as the primary :3020 gateway — never a second
 *      backend), add it to config.json as an "alt" environment, atomically
 *      flip `activeEnv` from "sandbox" to "alt", wait for the reload
 *      notification, confirm a tool call succeeds — then kill the :3022
 *      process this suite owns and confirm the NEXT tool call FAILS. That
 *      fail-after-kill is the actual behavioral proof the switch re-targeted
 *      the live connection (a proxy still silently bound to :3020 would keep
 *      succeeding). Restores `activeEnv: "sandbox"` afterward.
 *  12. (W3 · UX-ROUND-2-PLAN.md) Tool-selector: a SEPARATE, self-contained,
 *      unlocked proxy — disable a known tool (`grc_scopes`) via a live
 *      config write, confirm `tools/list` omits it and a direct call returns
 *      the documented isError, then re-enable it and confirm both are
 *      restored.
 *
 * This suite reuses the fm-devcontainer sidecar's gateway already running at
 * http://localhost:3020/mcp for every leg except the env-switch leg above,
 * which spawns its own second gateway instance (from the already-built
 * /workspaces/fmmcp-gw dist) specifically to prove a cross-gateway switch —
 * unlike scripts/test-runner.mjs, this suite never spawns a gateway to stand
 * in for the primary :3020 one.
 *
 * Process-group-kill convention (curriculum 08-pitfalls-log #1; mirrors
 * fmmcp-gw scripts/test-runner.mjs + update-tool-surface.mjs): the proxy is
 * spawned via "yarn node dist/local-mcp/cli.js", and "yarn node" wraps the
 * real node process — a plain `child.kill()` reaps only the yarn wrapper and
 * orphans the grandchild, which then holds its stdio pipes open and hangs the
 * shell. We spawn with `detached: true` (its own process group) and kill with
 * `process.kill(-child.pid, 'SIGTERM')` in a try/catch. Because we own the
 * spawn (for that group-kill guarantee), we can't hand the child to the SDK's
 * `StdioClientTransport` — it insists on spawning its own, non-detached,
 * child — so this file wires a minimal `Transport` over the already-spawned
 * child's stdio, reusing the SDK's own `ReadBuffer`/`serializeMessage` stdio
 * framing helpers (the same ones `StdioClientTransport` uses internally).
 *
 * Usage:
 *   yarn build && yarn test:hot-reload
 *   (equivalently: yarn node scripts/hot-reload-test.mjs)
 *
 * Prereqs: dist/ built (yarn build); ~/.fmcode/credentials.json has a working
 * "sandbox" block; the dev-pod gateway sidecar answers at
 * http://localhost:3020/health; /workspaces/fmmcp-gw's own dist/ is already
 * built (this suite reuses it as-is for the env-switch leg's second gateway
 * instance — it never builds fmmcp-gw itself).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const GATEWAY_URL = 'http://localhost:3020/mcp'; // fm-devcontainer sidecar — reused, never spawned here
const GATEWAY_HEALTH_URL = 'http://localhost:3020/health';
const EXPECTED_TOOL_COUNT = 16; // 13 relayed gateway tools + 3 local documents tools
const DOC_TOOLS = new Set(['grc_documents_read', 'grc_documents_write', 'grc_documents_delete']);
// Same scope as scripts/test-runner.mjs's SCOPE_ID (barsoommsp) — resolved to
// a NAME below via the live grc_scopes list, never hardcoded as a name.
const SCOPE_ID = '5da7314e388a0c6302e1f776';
const NOTIFICATION_TIMEOUT_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

// R7/F8: the "alt" gateway used by the env-switch leg — a SECOND fmmcp-gw
// instance on a port of its own (off 3020 sidecar, 3021 fmmcp-gw's own E2E
// runner, 3023 fmmcp-gw's tool-surface updater), pointed at the SAME sandbox
// upstream as the primary :3020 gateway so both serve identical data. Never
// a second backend — see spawnAltGateway below.
const ALT_GATEWAY_PORT = 3022;
const ALT_GATEWAY_URL = `http://localhost:${String(ALT_GATEWAY_PORT)}/mcp`;
const ALT_GATEWAY_HEALTH_URL = `http://localhost:${String(ALT_GATEWAY_PORT)}/health`;
const FMMCP_GW_DIR = '/workspaces/fmmcp-gw';

let failureCount = 0;

/** Non-fatal assertion: logs PASS/FAIL and keeps going so later diagnostics still print. */
function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    failureCount += 1;
    console.log(`  ❌ ${message}`);
  }
}

/**
 * Poll a health endpoint until it responds ok or the deadline passes.
 * `hint` is appended to the timeout error to clarify which gateway this was
 * waiting on (the reused :3020 sidecar vs. a gateway this suite spawned).
 */
async function waitForHealth(
  url,
  timeoutMs,
  hint = 'This suite reuses the already-running fm-devcontainer sidecar gateway — it does not spawn one.',
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway health check timed out after ${String(timeoutMs)}ms at ${url} (${lastError}). ${hint}`);
}

/** Build the initial (unlocked) config.json content. */
function buildConfig(scopeLock) {
  return {
    version: 1,
    activeEnv: 'sandbox',
    scopeLock,
    environments: { sandbox: { gateway: GATEWAY_URL } },
    ideSync: { claude: true, vscode: true, cursor: true, codex: true, antigravity: true },
    logLevel: 'info',
  };
}

let writeConfigAtomicCounter = 0;

/**
 * Atomic write (tmp + rename) — mirrors src/registry/config.ts's saveConfig()
 * so the running proxy's fs.watch (which watches the parent directory
 * specifically to survive rename-based writes) reliably picks it up.
 *
 * The tmp filename includes a per-call counter so that the rapid
 * double-write leg (R1/F2 below), which fires two of these with no
 * await/sleep in between, never has both calls' `writeFile` interleave on
 * the SAME tmp path — that would be a test-harness race, not the thing under
 * test. `rename` itself is still what makes each write atomic from the
 * watcher's point of view; the counter only keeps two concurrent callers'
 * tmp files from colliding with each other.
 */
async function writeConfigAtomic(fmcodeDir, config) {
  const path = join(fmcodeDir, 'config.json');
  const tmpPath = `${path}.${String(process.pid)}.${String(writeConfigAtomicCounter++)}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, path);
}

/**
 * Copy ONLY the real sandbox credentials block into the temp FMCODE_DIR —
 * plus an identical copy under "alt" (same token/base/scopeMap), since
 * credentials are resolved per-environment-NAME (`src/registry/credentials.ts`)
 * and the R7/F8 env-switch leg's "alt" environment is the SAME sandbox
 * upstream served by a second gateway process, never a second backend or a
 * different credential. Never hardcodes a fake token, never carries any
 * other REAL env's credentials into the temp file.
 */
async function writeSandboxCredentials(fmcodeDir) {
  const realPath = join(homedir(), '.fmcode', 'credentials.json');
  const raw = JSON.parse(await readFile(realPath, 'utf-8'));
  const sandbox = raw.environments?.sandbox;
  if (!sandbox || typeof sandbox !== 'object') {
    throw new Error(`No "sandbox" environment block found in ${realPath} — cannot build a test credentials.json.`);
  }

  const path = join(fmcodeDir, 'credentials.json');
  await writeFile(path, `${JSON.stringify({ environments: { sandbox, alt: sandbox } }, null, 2)}\n`, 'utf-8');
  await chmod(path, 0o600);
}

/**
 * Spawn the built proxy, config-driven only (no flags), against the temp
 * FMCODE_DIR. Detached: own process group for the group-kill cleanup below.
 *
 * stderr is piped (not 'inherit') and buffered in `stderrBuffer` so the
 * bad-gateway-quarantine leg (R1/F1) can assert on the child's log text (e.g.
 * "QUARANTINED") — it is also mirrored line-for-line to
 * this script's own stderr so live debugging output isn't lost.
 */
function spawnProxy(fmcodeDir) {
  const child = spawn('yarn', ['node', 'dist/local-mcp/cli.js'], {
    cwd: process.cwd(),
    env: { ...process.env, FMCODE_DIR: fmcodeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.on('error', (error) => {
    console.error(`  Proxy process error: ${error.message}`);
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf-8');
    process.stderr.write(chunk);
  });
  child.getStderr = () => stderrBuffer;

  return child;
}

/**
 * Kill the whole process group the proxy started in (SIGTERM) — "yarn node"
 * wraps the real node process, so a plain child.kill() would orphan the
 * grandchild. Wrapped in try/catch: the process may already have exited.
 */
function killProxyGroup(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/**
 * R7/F8 env-switch leg: spawn a SECOND fmmcp-gw gateway instance (built dist,
 * reused from /workspaces/fmmcp-gw) on ALT_GATEWAY_PORT, pointed at the SAME
 * sandbox upstream API as the primary :3020 gateway via CONTINURISK_API_URL —
 * mirrors fmmcp-gw's own scripts/test-runner.mjs (`fortmesa_api_base` from
 * ~/.fmcode/credentials.json's "sandbox" block) and this repo's own
 * scripts/probe-badtoken.mjs, which spawn fmmcp-gw the same way. Never a
 * second backend — both gateways serve identical data.
 *
 * Detached (own process group), same convention as spawnProxy above, so it
 * can be torn down with killProxyGroup()/waitForExit() alongside the proxy
 * child in the caller's finally block.
 */
async function spawnAltGateway() {
  const credsPath = join(homedir(), '.fmcode', 'credentials.json');
  const raw = JSON.parse(await readFile(credsPath, 'utf-8'));
  const apiBase = raw.environments?.sandbox?.fortmesa_api_base;
  if (typeof apiBase !== 'string' || apiBase === '') {
    throw new Error(
      `No "sandbox" environment "fortmesa_api_base" found in ${credsPath} — cannot spawn the alt gateway pointed ` +
        'at the same upstream as the primary :3020 gateway.',
    );
  }

  const child = spawn('yarn', ['node', 'dist/server/index.js', '--http', '--port', String(ALT_GATEWAY_PORT)], {
    cwd: FMMCP_GW_DIR,
    env: { ...process.env, CONTINURISK_API_URL: apiBase },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.on('error', (error) => {
    console.error(`  Alt gateway process error: ${error.message}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[alt-gateway] ${chunk.toString('utf-8')}`);
  });

  await waitForHealth(
    ALT_GATEWAY_HEALTH_URL,
    HEALTH_CHECK_TIMEOUT_MS,
    `This is the "alt" gateway this suite spawns itself from ${FMMCP_GW_DIR}'s built dist for the env-switch leg.`,
  );
  return child;
}

/** Resolve once the child has exited, or after timeoutMs — whichever comes first. Best-effort, never rejects. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A minimal MCP `Transport` over an already-spawned child process's stdio.
 *
 * We can't use the SDK's `StdioClientTransport` here — it insists on
 * spawning its own (non-detached) child, which would defeat the
 * process-group-kill cleanup this suite needs. Reuses the SDK's own
 * `ReadBuffer`/`serializeMessage` newline-delimited JSON-RPC framing, so the
 * wire format is identical to what `StdioClientTransport` produces/consumes.
 */
function createManagedStdioTransport(child) {
  const readBuffer = new ReadBuffer();

  const transport = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    start() {
      child.stdout.on('data', (chunk) => {
        readBuffer.append(chunk);
        drainMessages();
      });
      child.stdout.on('error', (error) => {
        transport.onerror?.(error);
      });
      child.stdin.on('error', (error) => {
        transport.onerror?.(error);
      });
      child.on('close', () => {
        transport.onclose?.();
      });
      return Promise.resolve();
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const wrote = child.stdin.write(serializeMessage(message), (error) => {
          if (error) reject(error);
        });
        if (wrote) {
          resolve();
        } else {
          child.stdin.once('drain', resolve);
        }
      });
    },
    close() {
      // Process termination is owned by killProxyGroup() below — this only
      // tears down the transport's own message-framing state.
      readBuffer.clear();
      return Promise.resolve();
    },
  };

  function drainMessages() {
    for (;;) {
      let message;
      try {
        message = readBuffer.readMessage();
      } catch (error) {
        transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message === null) return;
      transport.onmessage?.(message);
    }
  }

  return transport;
}

/** Extract the first text-content block's string from a CallToolResult, if any. */
function firstText(result) {
  const content = result.content;
  const first = Array.isArray(content) ? content.find((c) => c && c.type === 'text') : undefined;
  return first && typeof first.text === 'string' ? first.text : undefined;
}

/** Call an MCP tool and return its parsed JSON text content. Throws on tool-level errors or unexpected shapes. */
async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = firstText(result);

  if (result.isError === true) {
    throw new Error(`Tool "${name}" returned an error: ${text ?? '(no text content)'}`);
  }
  if (text === undefined) {
    throw new Error(`Tool "${name}" returned no text content (shape: ${JSON.stringify(result)})`);
  }
  return JSON.parse(text);
}

/** Call an MCP tool and return the raw CallToolResult (never throws on isError — the caller inspects it directly). */
async function callToolRaw(client, name, args) {
  return client.callTool({ name, arguments: args });
}

/** Poll `check()` until it returns truthy or the deadline passes. Returns the last (possibly falsy) value on timeout — never throws itself. */
async function pollUntil(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function listScopes(client) {
  const parsed = await callToolJson(client, 'grc_scopes', { method: 'list' });
  if (!Array.isArray(parsed)) {
    throw new Error(`grc_scopes list returned a non-array result: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function scopeId(scope) {
  return typeof scope.id === 'string' ? scope.id : typeof scope._id === 'string' ? scope._id : undefined;
}

/** Subscribe to notifications/tools/list_changed and hand back a bounded waiter. Must be called BEFORE the mutation that should trigger it. */
function subscribeToolListChanged(client) {
  let fired = false;
  let resolveFired;
  const firedPromise = new Promise((resolve) => {
    resolveFired = resolve;
  });

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    fired = true;
    resolveFired();
  });

  return {
    async wait(timeoutMs) {
      if (fired) return true;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([firedPromise.then(() => 'notified'), timeout]);
      clearTimeout(timer);
      return outcome === 'notified';
    },
  };
}

/**
 * R2/F3 leg: spawns its OWN short-lived proxy that boots ALREADY scope-locked
 * to `targetName` (a real, non-trivial startup-captured lock — unlike the
 * main suite's process, which always boots unlocked), then switches live to
 * `otherName` and calls the LOCAL `grc_documents_read` tool naming
 * `otherScopeId`.
 *
 * Post-fix (`getLock()` read at call time): the live proxy lock now allows
 * `otherScopeId`, and documents.ts's handler reads that same live lock — the
 * call succeeds.
 *
 * Pre-fix (`registerDocumentTools(registry, lock)` capturing the STARTUP
 * lock by value): documents.ts's captured lock is still restricted to
 * `targetName`'s scope — the call incorrectly fails with the scope-lock
 * `isError`, even though the live proxy lock (and a relayed `grc_scopes
 * list`) both now agree `otherScopeId` is authorized. That divergence IS the
 * over-enforcement bug.
 */
async function runF3LiveLockLeg(assert, { targetName, otherName, otherScopeId }) {
  const fmcodeDir = mkdtempSync(join(tmpdir(), 'fmmcp-hot-reload-f3-'));
  let child;
  let client;
  try {
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'single', scopes: [targetName] }));
    await writeSandboxCredentials(fmcodeDir);

    child = spawnProxy(fmcodeDir);
    const transport = createManagedStdioTransport(child);
    client = new Client({ name: 'hot-reload-test-f3', version: '1.0.0' });
    await client.connect(transport);

    // Sanity: the live (proxy-level) lock is genuinely restricted to
    // targetName's scope at boot, before any switch — the documents tool
    // call below matters only relative to a real starting restriction.
    const bootScopes = await listScopes(client);
    assert(
      bootScopes.length === 1 && scopeId(bootScopes[0]) !== otherScopeId,
      `R2/F3 setup: second proxy boots pre-locked to "${targetName}" only (got ${String(bootScopes.length)} scope(s))`,
    );

    const notification = subscribeToolListChanged(client);
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'single', scopes: [otherName] }));
    await notification.wait(NOTIFICATION_TIMEOUT_MS);

    // Poll: the config-watch debounce (~150ms) plus this reload's own
    // network round-trip mean the live lock may not have swapped the
    // instant the notification fires.
    const newScopeResult = await pollUntil(
      async () => callToolRaw(client, 'grc_documents_read', { method: 'list', scopeId: otherScopeId }),
      3000,
      200,
    );
    assert(
      newScopeResult !== undefined && newScopeResult.isError !== true,
      `grc_documents_read list succeeds for the NEWLY-locked scope (${otherScopeId}) via the LIVE lock after ` +
        `switching from "${targetName}" to "${otherName}" (proves the documents tools' lock followed the switch, ` +
        `not a stale startup capture) — isError: ${String(newScopeResult?.isError)}, ` +
        `text: ${String(firstText(newScopeResult ?? {})).slice(0, 200)}`,
    );
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
    if (child) {
      killProxyGroup(child);
      await waitForExit(child, 2000);
    }
    rmSync(fmcodeDir, { recursive: true, force: true });
  }
}

/**
 * R7/F8 leg: proves a live env switch (not just a scope-lock switch within
 * the SAME gateway) actually re-targets the proxy's outbound connection to a
 * DIFFERENT gateway process.
 *
 * Spawns a second fmmcp-gw instance on ALT_GATEWAY_PORT (same sandbox
 * upstream as the primary :3020 gateway — see spawnAltGateway), adds it to
 * the running proxy's config.json as an "alt" environment, then atomically
 * flips activeEnv from "sandbox" to "alt" and waits for the reload
 * notification.
 *
 * The behavioral proof (not just "no error was thrown"): a `grc_scopes list`
 * call succeeds immediately after the switch (served by :3022, since the
 * proxy has by now released its :3020 connection per reload()'s
 * connect-new/swap/close-old order — R1), and then THIS SUITE KILLS ITS OWN
 * :3022 gateway process (the one thing it owns and fully controls, unlike
 * the shared :3020 sidecar) and asserts the NEXT `grc_scopes list` call
 * fails. A proxy that was still silently talking to :3020 would keep
 * succeeding after :3022 dies — only a proxy that actually switched its live
 * connection to :3022 goes on to fail once :3022 is gone. Restores
 * `activeEnv: "sandbox"` afterward so later legs in this file keep serving
 * against the primary gateway.
 */
async function runEnvSwitchLeg(assert, { fmcodeDir, config, scopeLock, client, notification }) {
  let altGateway;
  try {
    altGateway = await spawnAltGateway();
    console.log(`Spawned alt gateway on :${String(ALT_GATEWAY_PORT)} (${ALT_GATEWAY_URL}), upstream matches sandbox`);

    const configWithAlt = {
      ...config,
      environments: { ...config.environments, alt: { gateway: ALT_GATEWAY_URL } },
    };
    await writeConfigAtomic(fmcodeDir, configWithAlt);
    console.log('Wrote config.json with an "alt" environment entry (activeEnv still "sandbox")');

    await writeConfigAtomic(fmcodeDir, { ...configWithAlt, activeEnv: 'alt' });
    console.log('Flipped activeEnv: "sandbox" -> "alt"');

    const received = await notification.wait(NOTIFICATION_TIMEOUT_MS);
    assert(
      received,
      `received notifications/tools/list_changed within ${String(NOTIFICATION_TIMEOUT_MS)}ms of the env switch`,
    );

    const servedByAlt = await pollUntil(
      async () => {
        try {
          const scopes = await listScopes(client);
          return scopes.length > 0 ? scopes : undefined;
        } catch {
          return undefined;
        }
      },
      3000,
      300,
    );
    assert(
      Array.isArray(servedByAlt) && servedByAlt.length > 0,
      `a grc_scopes list call succeeds after the env switch to "alt" (got ${String(Array.isArray(servedByAlt) ? servedByAlt.length : 'a thrown error')} scope(s))`,
    );

    // THE actual proof: kill the alt gateway (this suite's own process, torn
    // down the same detached-group way as the proxy) and confirm the proxy's
    // NEXT call fails. If the proxy were still secretly bound to :3020, this
    // call would keep succeeding — :3020 is untouched.
    killProxyGroup(altGateway);
    await waitForExit(altGateway, 2000);
    altGateway = undefined;
    console.log('Killed the alt (:3022) gateway process group');

    const failsAfterAltDeath = await pollUntil(
      async () => {
        try {
          await listScopes(client);
          return undefined; // still succeeding — not yet observed as failing
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      3000,
      300,
    );
    assert(
      typeof failsAfterAltDeath === 'string',
      "a grc_scopes list call FAILS once the alt (:3022) gateway is killed — proves the proxy's live " +
        `serving path had actually moved to :${String(ALT_GATEWAY_PORT)}, not silently still :3020 ` +
        `(result: ${String(failsAfterAltDeath ?? 'call kept succeeding')})`,
    );
  } finally {
    if (altGateway) {
      killProxyGroup(altGateway);
      await waitForExit(altGateway, 2000);
    }
    // Restore a healthy, reachable environment so any legs that run after
    // this one (and the top-level cleanup) still find a live proxy.
    await writeConfigAtomic(fmcodeDir, buildConfig(scopeLock));
    console.log('Restored activeEnv: "alt" -> "sandbox" (alt gateway is gone; later steps need a live one)');
  }
}

/**
 * W3 leg (UX-ROUND-2-PLAN.md): proves the `disabledTools` proxy feature
 * actually changes LIVE `tools/list` + `CallTool` behavior, not just that
 * config.json accepts the field.
 *
 * Self-contained (own temp FMCODE_DIR, proxy, client — mirrors
 * `runF3LiveLockLeg`'s isolation) rather than reusing `main()`'s shared,
 * already scope-locked proxy: this leg is unlocked throughout, so
 * `grc_scopes list` (no scopeId argument, always valid regardless of lock
 * state — the same call used as a health probe everywhere else in this
 * file) is a safe, unambiguous target to disable/re-enable without
 * disturbing any other leg's sequencing or state.
 */
async function runToolSelectorLeg(assert) {
  const DISABLED_TOOL = 'grc_scopes';
  const fmcodeDir = mkdtempSync(join(tmpdir(), 'fmmcp-hot-reload-w3-'));
  let child;
  let client;
  try {
    await writeConfigAtomic(fmcodeDir, { ...buildConfig({ mode: 'unlocked', scopes: [] }), disabledTools: [] });
    await writeSandboxCredentials(fmcodeDir);

    child = spawnProxy(fmcodeDir);
    const transport = createManagedStdioTransport(child);
    client = new Client({ name: 'hot-reload-test-w3', version: '1.0.0' });
    await client.connect(transport);

    const beforeTools = await client.listTools();
    assert(
      beforeTools.tools.some((t) => t.name === DISABLED_TOOL),
      `W3 setup: "${DISABLED_TOOL}" is present in tools/list before it is disabled`,
    );
    const beforeCall = await callToolRaw(client, DISABLED_TOOL, { method: 'list' });
    assert(beforeCall.isError !== true, `W3 setup: "${DISABLED_TOOL}" is callable before it is disabled`);

    const disableNotification = subscribeToolListChanged(client);
    await writeConfigAtomic(fmcodeDir, {
      ...buildConfig({ mode: 'unlocked', scopes: [] }),
      disabledTools: [DISABLED_TOOL],
    });
    console.log(`Wrote config disabling "${DISABLED_TOOL}"`);
    await disableNotification.wait(NOTIFICATION_TIMEOUT_MS);

    const afterDisableTools = await pollUntil(
      async () => {
        const tools = await client.listTools();
        return tools.tools.some((t) => t.name === DISABLED_TOOL) ? undefined : tools;
      },
      3000,
      200,
    );
    assert(afterDisableTools !== undefined, `tools/list omits "${DISABLED_TOOL}" after it is disabled`);

    const disabledCallResult = await pollUntil(
      async () => {
        const result = await callToolRaw(client, DISABLED_TOOL, { method: 'list' });
        return result.isError === true ? result : undefined;
      },
      3000,
      200,
    );
    const expectedMessage = `tool '${DISABLED_TOOL}' is disabled in Saferoom settings`;
    assert(
      disabledCallResult !== undefined && firstText(disabledCallResult) === expectedMessage,
      `a direct call to the disabled tool returns the documented isError ` +
        `(got: ${String(firstText(disabledCallResult ?? {}))}, expected: ${expectedMessage})`,
    );

    const reenableNotification = subscribeToolListChanged(client);
    await writeConfigAtomic(fmcodeDir, { ...buildConfig({ mode: 'unlocked', scopes: [] }), disabledTools: [] });
    console.log(`Wrote config re-enabling "${DISABLED_TOOL}"`);
    await reenableNotification.wait(NOTIFICATION_TIMEOUT_MS);

    const afterReenableTools = await pollUntil(
      async () => {
        const tools = await client.listTools();
        return tools.tools.some((t) => t.name === DISABLED_TOOL) ? tools : undefined;
      },
      3000,
      200,
    );
    assert(afterReenableTools !== undefined, `tools/list includes "${DISABLED_TOOL}" again after re-enabling`);

    const reenabledCall = await pollUntil(
      async () => {
        const result = await callToolRaw(client, DISABLED_TOOL, { method: 'list' });
        return result.isError === true ? undefined : result;
      },
      3000,
      200,
    );
    assert(reenabledCall !== undefined, `"${DISABLED_TOOL}" is callable again after re-enabling`);
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
    if (child) {
      killProxyGroup(child);
      await waitForExit(child, 2000);
    }
    rmSync(fmcodeDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=== fmmcp-local Hot-Reload E2E ===\n');

  await waitForHealth(GATEWAY_HEALTH_URL, HEALTH_CHECK_TIMEOUT_MS);
  console.log(`Gateway reachable at ${GATEWAY_URL}\n`);

  const fmcodeDir = mkdtempSync(join(tmpdir(), 'fmmcp-hot-reload-'));
  console.log(`Temp FMCODE_DIR: ${fmcodeDir}`);

  let child;
  let client;

  try {
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'unlocked', scopes: [] }));
    await writeSandboxCredentials(fmcodeDir);
    console.log('Wrote config.json (unlocked) + credentials.json (sandbox block only)\n');

    console.log('Spawning proxy: yarn node dist/local-mcp/cli.js (flag-less, config-driven)...');
    child = spawnProxy(fmcodeDir);
    const transport = createManagedStdioTransport(child);

    client = new Client({ name: 'hot-reload-test', version: '1.0.0' });
    await client.connect(transport);
    console.log('Connected over stdio.\n');

    // ── Step 3: full tool surface ────────────────────────────
    const tools = await client.listTools();
    const docCount = tools.tools.filter((t) => DOC_TOOLS.has(t.name)).length;
    assert(
      tools.tools.length === EXPECTED_TOOL_COUNT && docCount === DOC_TOOLS.size,
      `tools/list returns ${String(EXPECTED_TOOL_COUNT)} tools (13 relayed + ${String(DOC_TOOLS.size)} local documents) ` +
        `— got ${String(tools.tools.length)} total, ${String(docCount)} documents`,
    );

    // ── Step 4: baseline grc_scopes list (unlocked) ──────────
    const baselineScopes = await listScopes(client);
    console.log(`Baseline grc_scopes list (unlocked): ${String(baselineScopes.length)} scope(s)`);
    assert(baselineScopes.length > 0, 'baseline grc_scopes list returns at least one scope while unlocked');

    const target = baselineScopes.find((s) => scopeId(s) === SCOPE_ID);
    if (!target || typeof target.name !== 'string' || target.name === '') {
      throw new Error(
        `Could not find scope id "${SCOPE_ID}" with a "name" field in the baseline grc_scopes list ` +
          `(got ids: [${baselineScopes.map(scopeId).join(', ')}]) — cannot proceed with the lock-switch assertion.`,
      );
    }
    const targetName = target.name;
    console.log(`Resolved lock target: id=${SCOPE_ID} name="${targetName}"\n`);

    // ── Step 5: subscribe BEFORE mutating config.json ────────
    const notification = subscribeToolListChanged(client);

    // ── Step 6: atomically flip the scope lock ───────────────
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'single', scopes: [targetName] }));
    console.log(`Wrote scope-lock config: mode=single, scopes=["${targetName}"]`);

    // ── Step 7: wait for the reload notification ─────────────
    const received = await notification.wait(NOTIFICATION_TIMEOUT_MS);
    assert(
      received,
      `received notifications/tools/list_changed within ${String(NOTIFICATION_TIMEOUT_MS)}ms of the scope-lock change`,
    );
    if (!received) {
      throw new Error('tools/list_changed notification timed out — hot-reload did not fire.');
    }

    // ── Step 8: THE actual proof — live call behavior changed ─
    const afterScopes = await listScopes(client);
    const afterIds = afterScopes.map(scopeId);
    const onlyLockedScope = afterIds.length > 0 && afterIds.every((id) => id === SCOPE_ID);
    const noWiderThanBaseline = afterScopes.length <= baselineScopes.length;
    assert(
      onlyLockedScope && noWiderThanBaseline,
      `grc_scopes list is filtered to ONLY the locked scope after reload ` +
        `(before: ${String(baselineScopes.length)}, after: ${String(afterScopes.length)}, ids: [${afterIds.join(', ')}])`,
    );

    // ── Step 9 (R2/F3): local documents tool must read the LIVE lock ────
    // F3 is an OVER-enforcement bug: the proxy-level scope-lock check (which
    // DOES read the live lock — proxy.ts reassigns its own outer `let lock`
    // in reload()) always runs first and would reject an unauthorized scope
    // regardless of documents.ts's inner check — so a scope the CURRENT lock
    // rejects never even reaches documents.ts's own check, and a bug there
    // can only be OBSERVED by documents.ts wrongly REJECTING a scope the
    // live proxy lock now ALLOWS.
    //
    // registerDocumentTools captures its `lock` argument at CLI STARTUP
    // (before the very first `startProxy` call), not at any later config
    // switch. In THIS suite's process (booted unlocked, only ever switched
    // via live config writes afterward), that startup capture is always
    // `ScopeLock.unlocked()` — which never rejects anything, pre- or
    // post-fix — so no live switch performed against THIS already-running
    // process can expose F3: an unlocked stale capture is indistinguishable
    // from a live one for every assertion shape available here.
    //
    // Reproducing F3 for real requires a startup-time lock that is ALREADY
    // restrictive, so this leg spawns a SEPARATE, short-lived proxy that
    // boots pre-locked to `targetName` (a real, non-trivial captured lock),
    // switches live to `otherName`, then calls grc_documents_read naming
    // `otherName`'s scope: the live proxy lock now allows it, but pre-fix
    // documents.ts's stale captured lock (still `targetName`-only) rejects
    // it — the true over-enforcement failure mode.
    console.log('\n--- R2/F3: local grc_documents_read must read the LIVE (post-switch) lock ---');
    const otherScope = baselineScopes.find((s) => scopeId(s) !== SCOPE_ID && typeof scopeId(s) === 'string');
    if (!otherScope || typeof otherScope.name !== 'string' || otherScope.name === '') {
      throw new Error(
        'Need at least one OTHER scope (with a "name" field) besides SCOPE_ID in baselineScopes to prove the ' +
          `live-lock switch (got only: [${baselineScopes.map(scopeId).join(', ')}]).`,
      );
    }
    const otherScopeId = scopeId(otherScope);
    const otherName = otherScope.name;

    await runF3LiveLockLeg(assert, { targetName, otherName, otherScopeId });

    // ── Step 10 (R1/F1): a failed reload must QUARANTINE, not keep the OLD environment ─
    console.log(
      '\n--- R1/F1: reload to an unreachable gateway must QUARANTINE the proxy, not keep serving the old scope ---',
    );
    await writeConfigAtomic(fmcodeDir, {
      ...buildConfig({ mode: 'single', scopes: [otherName] }),
      environments: { sandbox: { gateway: 'http://127.0.0.1:1/mcp' } },
    });
    console.log("Wrote config pointing activeEnv's gateway at an unreachable address (http://127.0.0.1:1/mcp)");

    // Give the watcher's debounce + a failed connect attempt time to run, then
    // confirm every call is now refused rather than quietly served by the OLD
    // gateway and OLD scope lock.
    const quarantinedResult = await pollUntil(
      async () => {
        const result = await callToolRaw(client, 'grc_scopes', { method: 'list' });
        return result.isError === true ? result : undefined;
      },
      5000,
      300,
    );
    assert(
      quarantinedResult !== undefined && quarantinedResult.isError === true,
      'a tool call after the bad-gateway config write is REFUSED (isError) rather than served by the OLD gateway/scope',
    );
    const quarantineText = firstText(quarantinedResult) ?? '';
    assert(
      /could not apply the last environment\/scope change/i.test(quarantineText),
      `the refusal explains that a Saferoom-side reload failed (got: ${quarantineText.slice(0, 200)})`,
    );
    assert(
      /NOT an authorisation decision/i.test(quarantineText),
      'the refusal explicitly disclaims being an authorisation decision',
    );

    const stderrMentionsQuarantine = await pollUntil(
      () => child.getStderr().includes('QUARANTINED') || undefined,
      3000,
      200,
    );
    assert(Boolean(stderrMentionsQuarantine), 'proxy stderr logged the failed reload as "QUARANTINED"');

    // ── Step 11 (R1/F2): rapid double-write must apply only the LAST one ─
    console.log('\n--- R1/F2: two config writes back-to-back must serialize — final state matches the LAST write ---');
    // First write re-locks to the OTHER scope with a reachable gateway
    // (recovering from the bad-gateway config above), the second (written
    // immediately after) locks back to the ORIGINAL target scope. There is
    // deliberately no sleep/delay and no wait for a RELOAD to complete
    // in between the two writes — that is the race F2 guards against. The
    // two `writeConfigAtomic` calls themselves ARE sequenced (awaited one
    // after the other, each using its own unique tmp filename) purely so the
    // WRITES land on disk in a well-defined order — two disk writes started
    // in parallel with no shared ordering guarantee would make "the LAST
    // write" ambiguous at the filesystem level, which would be a test
    // harness flaw, not a demonstration of the reload race under test.
    const doubleWriteNotification = subscribeToolListChanged(client);
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'single', scopes: [otherName] }));
    await writeConfigAtomic(fmcodeDir, buildConfig({ mode: 'single', scopes: [targetName] }));
    console.log(
      `Wrote two config states back-to-back: scopes=["${otherName}"] then scopes=["${targetName}"] (no sleep/reload-wait between writes)`,
    );

    await doubleWriteNotification.wait(NOTIFICATION_TIMEOUT_MS);
    // The debounce + queue may coalesce the two writes into one reload, or
    // run them as two serialized reloads — either way, give it a moment to
    // settle on the LAST write's state before asserting.
    const finalScopes = await pollUntil(
      async () => {
        const scopes = await listScopes(client);
        const ids = scopes.map(scopeId);
        return ids.length > 0 && ids.every((id) => id === SCOPE_ID) ? scopes : undefined;
      },
      5000,
      300,
    );
    assert(
      Array.isArray(finalScopes),
      `final live grc_scopes list matches ONLY the LAST config write (scope "${targetName}" / ${SCOPE_ID})`,
    );

    const postDoubleWriteTools = await client.listTools();
    assert(
      postDoubleWriteTools.tools.length === EXPECTED_TOOL_COUNT,
      `process is still healthy after the rapid double-write — tools/list still returns ${String(EXPECTED_TOOL_COUNT)} tools`,
    );

    // ── Step 12 (R7/F8): env switch to a SECOND gateway (:3022) ─────────
    console.log('\n--- R7/F8: switching activeEnv must re-target the proxy to a DIFFERENT gateway process ---');
    const envSwitchScopeLock = { mode: 'single', scopes: [targetName] };
    const envSwitchNotification = subscribeToolListChanged(client);
    await runEnvSwitchLeg(assert, {
      fmcodeDir,
      config: buildConfig(envSwitchScopeLock),
      scopeLock: envSwitchScopeLock,
      client,
      notification: envSwitchNotification,
    });

    // runEnvSwitchLeg restores activeEnv: "sandbox" in its finally block —
    // confirm the proxy is healthy again against the primary gateway before
    // falling into this function's own cleanup.
    const postEnvSwitchScopes = await pollUntil(
      async () => {
        try {
          const scopes = await listScopes(client);
          const ids = scopes.map(scopeId);
          return ids.length > 0 && ids.every((id) => id === SCOPE_ID) ? scopes : undefined;
        } catch {
          return undefined;
        }
      },
      5000,
      300,
    );
    assert(
      Array.isArray(postEnvSwitchScopes),
      'proxy is healthy again against the primary :3020 gateway after the env-switch leg restores activeEnv: "sandbox"',
    );

    // ── Step 13 (W3): tool-selector disabledTools proxy feature ─────────
    console.log('\n--- W3: disabledTools must hide a tool from tools/list and reject a direct call ---');
    await runToolSelectorLeg(assert);
  } catch (error) {
    failureCount += 1;
    console.error(`\n❌ FATAL: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    console.log('\n--- Cleanup ---');
    if (client) {
      await client.close().catch((error) => {
        console.error(`  client.close() error (ignored): ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (child) {
      killProxyGroup(child);
      await waitForExit(child, 2000);
    }
    rmSync(fmcodeDir, { recursive: true, force: true });
    console.log(`  Removed temp FMCODE_DIR: ${fmcodeDir}`);
  }

  console.log(
    failureCount === 0
      ? '\n=== PASS: hot-reload E2E — reload() changes live request behavior ==='
      : `\n=== FAIL: hot-reload E2E — ${String(failureCount)} assertion(s) failed ===`,
  );
  process.exit(failureCount === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal (unhandled):', error);
  process.exit(2);
});
