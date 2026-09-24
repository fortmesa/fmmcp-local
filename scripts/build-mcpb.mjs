#!/usr/bin/env node
/**
 * Build the FortMesa Saferoom MCP Bundle (`.mcpb`).
 *
 * An MCPB is a zip holding a local MCP server plus a `manifest.json` that
 * describes it, which Claude Desktop and other MCPB hosts install in one
 * step. Format reference: github.com/modelcontextprotocol/mcpb (MANIFEST.md).
 * Required manifest fields are manifest_version, name, version, description,
 * author, and server.
 *
 * The payload is `dist-ext/cli.cjs`, the same esbuild bundle the VSIX ships.
 * It is already dependency-free CJS, so this bundle needs no `node_modules`
 * and the archive stays three files. That also means the `.mcpb` inherits the
 * prod-only strip for free: build it with FORTMESA_PROD_ONLY=true and the
 * bundle it wraps has already had the non-prod environments eliminated.
 *
 * The archive is written by `scripts/archive.mjs` rather than the
 * `@anthropic-ai/mcpb` CLI. Adding that CLI means committing its dependency
 * zips into `.yarn/cache` to keep CI's offline `--immutable` install working
 * (INV-HERMETIC), and the format is a zip with a JSON file in it.
 *
 * Usage: node scripts/build-mcpb.mjs [--out <path>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './archive.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

/**
 * The bundled CLI, not `dist/local-mcp/cli.js`.
 *
 * `dist/` is tsc's unbundled ESM tree and needs its 30-odd sibling modules
 * plus a resolver to run. `dist-ext/cli.cjs` is self-contained, which is what
 * an MCPB host spawns directly.
 */
const ENTRY_SOURCE = join(repoRoot, 'dist-ext/cli.cjs');
const ENTRY_IN_BUNDLE = 'server/cli.cjs';

function parseOutPath() {
  const index = process.argv.indexOf('--out');
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return join(repoRoot, `FortMesa-Saferoom-${pkg.version}.mcpb`);
}

/**
 * `${__dirname}` is the MCPB host's substitution for the installed bundle
 * root; it is not shell or Node syntax and must reach the manifest literally.
 */
function buildManifest() {
  return {
    manifest_version: '0.3',
    name: 'fortmesa-saferoom',
    display_name: 'FortMesa Saferoom',
    version: pkg.version,
    description: pkg.description,
    author: { name: 'FortMesa', url: 'https://fortmesa.com' },
    homepage: 'https://fortmesa.com',
    repository: { type: 'git', url: pkg.repository.url },
    icon: 'icon.png',
    keywords: ['fortmesa', 'grc', 'security', 'compliance', 'mcp'],
    /**
     * The bundle signs in with CIMD, the same OAuth flow the CLI and Saferoom
     * use. It does NOT ask for a pasted API token.
     *
     * The host cannot do this for us: MCP authorization is an HTTP-transport
     * feature, and the spec tells STDIO implementations to take credentials
     * from the environment instead. An MCPB server is stdio-spawned, so no
     * host ever runs OAuth on its behalf. What the bundle CAN do is run the
     * flow itself, which is what FMCODE_AUTO_LOGIN below turns on: no stored
     * credentials means open a browser, complete PKCE, write
     * `~/.fmcode/credentials.json`, and carry on. The refresh token stored
     * with it keeps the session alive without asking again.
     *
     * That leaves ONE optional question: which data region.
     *
     * There used to be two fields, an "Environment" string and an "API Base
     * URL". Both were wrong for this audience. MCPB user_config has no
     * enumerated type, so "Environment" rendered as a free-text box in which
     * anything but the word `prod` produced a server that could not start —
     * and it asked a customer to name an internal deployment tier. Production
     * is now passed literally in `args` below and is not a question at all.
     *
     * What remains is the one thing a customer can legitimately be told by
     * support: a different data region. It is a single optional URL, blank
     * meaning production NA-US, and it replaces the whole environment rather
     * than patching a base URL onto production's gateway and OAuth identity
     * (see `registry/environments.ts#deriveDataRegion`).
     */
    user_config: {
      data_region_url: {
        type: 'string',
        title: 'Data region override URL (optional)',
        // KEEP THIS SHORT. Claude Desktop echoes the description as the field's
        // PLACEHOLDER, so anything long is truncated mid-sentence and the user
        // never reads the end of it (PO, 2026-09-18).
        description:
          'Connects to FortMesa Production (US) by default. Enter a custom data region URL only if ' +
          'FortMesa support gave you one.',
        default: '',
        required: false,
      },
    },
    server: {
      type: 'node',
      entry_point: ENTRY_IN_BUNDLE,
      mcp_config: {
        command: 'node',
        // `--env` reaches the proxy the same way it does from a shell. The
        // token goes through the environment instead of argv so it never
        // appears in a process listing.
        args: [`\${__dirname}/${ENTRY_IN_BUNDLE}`, '--env', 'prod'],
        env: {
          // Turns on the browser sign-in described above. Set ONLY here: a
          // proxy started from a shell or an IDE must never pop a browser on
          // its own.
          FMCODE_AUTO_LOGIN: 'true',
          // Blank (the default) means production NA-US and is ignored. A
          // non-blank value REPLACES the `--env prod` above with the derived
          // region — gateway, API base, OAuth identity and credentials key
          // together. NOT FORTMESA_API_BASE: that variable is one half of the
          // paste-a-token credential chain and is inert without
          // FORTMESA_API_TOKEN, which a bundle never sets.
          FORTMESA_DATA_REGION: '\${user_config.data_region_url}',
        },
      },
    },
    compatibility: {
      runtimes: { node: `>=${String(pkg.engines.node).replace(/^>=/, '')}` },
    },
  };
}

/**
 * Extract the bundle as a host would install it, then start it the way a host
 * starts it and require that it gets as far as serving.
 *
 * The previous version of this ran `--help`, which proved only that the
 * module graph loads. It passed, and the bundle it blessed exited instantly
 * on a real install with "No credentials available for env sandbox". A smoke
 * test that cannot fail the way the product fails is not a smoke test.
 *
 * Five runs, because they catch different breakage:
 *
 *   1. NO credentials and no auto-login. Must fail, and must fail on
 *      credentials. This is the shape of the first shipped bug.
 *   2. WITH a token and `--env prod`, pointed at a closed port. Must get PAST
 *      credential resolution and die trying to reach the gateway. That proves
 *      config bootstrap, environment selection, API-base resolution and the
 *      env-var credential branch all work on a machine with no `~/.fmcode`,
 *      which is every MCPB install.
 *   3. THE MANIFEST'S OWN LAUNCH — auto-login, no credentials, nothing on the
 *      command line the manifest does not pass — speaking real MCP on stdin.
 *      It must ANSWER `initialize`. The previous version of this run asserted
 *      only that sign-in STARTED and that stdout was empty, and an empty
 *      stdout is exactly what a server that never answers produces: the run
 *      passed while a default Claude Desktop install showed "Unable to connect
 *      to extension server", because startup awaited a browser sign-in before
 *      connecting the transport. A smoke test that cannot fail the way the
 *      product fails is not a smoke test.
 *   4. A data region override. Must re-point the gateway and keep serving.
 *   5. A REJECTED data region override. Must still answer `initialize` (so the
 *      host has a server that can explain itself) and must NOT quietly fall
 *      back to production.
 *
 * Runs 2-5 deliberately stop at the network boundary. Going further would mean
 * a real gateway, and a build must not depend on one.
 */
async function smokeTest(entries) {
  const scratch = mkdtempSync(join(tmpdir(), 'fortmesa-mcpb-smoke-'));
  try {
    for (const entry of entries) {
      const target = join(scratch, entry.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }

    const server = join(scratch, ENTRY_IN_BUNDLE);
    const initialize = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpb-smoke', version: '0' } },
    })}\n`;

    /** Start the extracted server the way a host would, with an empty config dir. */
    const start = (args, extraEnv) =>
      spawnSync(process.execPath, [server, ...args], {
        input: initialize,
        encoding: 'utf-8',
        timeout: 90_000,
        env: { ...process.env, FMCODE_DIR: join(scratch, 'fmcode'), ...extraEnv },
      });

    const bare = start([], { FORTMESA_API_TOKEN: '' });
    if (!`${bare.stderr}`.includes('No credentials available')) {
      console.error('build-mcpb: FATAL: expected the un-configured run to fail on credentials.');
      console.error(`  Got exit=${String(bare.status)} stderr: ${`${bare.stderr}`.slice(0, 400)}`);
      console.error('  If this changed deliberately, update the smoke test rather than deleting it.');
      process.exit(1);
    }

    // 127.0.0.1:1 is reserved and never listening, so this fails fast and
    // offline instead of reaching anything real.
    const configured = start(['--env', 'prod', '--gateway', 'http://127.0.0.1:1/mcp'], {
      FORTMESA_API_TOKEN: 'smoke-test-not-a-real-token',
    });
    const stderr = `${configured.stderr}`;

    if (stderr.includes('No credentials available')) {
      console.error('build-mcpb: FATAL: the bundle cannot pick up a token from FORTMESA_API_TOKEN.');
      console.error(`  stderr: ${stderr.slice(0, 400)}`);
      process.exit(1);
    }
    if (!/ECONNREFUSED|fetch failed|connect|gateway/i.test(stderr)) {
      console.error('build-mcpb: FATAL: the configured run did not reach the gateway connection step.');
      console.error(`  exit=${String(configured.status)} stderr: ${stderr.slice(0, 400)}`);
      process.exit(1);
    }

    /**
     * Start the server the way an MCPB HOST does — spawn it, then speak MCP on
     * stdin — and return once `initialize` has been answered or the wait runs
     * out. Async on purpose: the fixed server no longer exits on its own, which
     * is the whole point, so `spawnSync` would simply block.
     */
    const serveAsHost = (args, extraEnv, waitMs = 20_000) =>
      new Promise((resolveRun) => {
        const child = spawn(process.execPath, [server, ...args], {
          env: { ...process.env, FMCODE_DIR: mkdtempSync(join(scratch, 'home-')), ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.stdin.write(initialize);
        const finish = () => {
          clearTimeout(deadline);
          clearInterval(poll);
          child.kill('SIGKILL');
          resolveRun({ stdout, stderr });
        };
        const poll = setInterval(() => {
          if (stdout.includes('"id":1')) finish();
        }, 100);
        const deadline = setTimeout(finish, waitMs);
        child.on('error', finish);
      });

    /** Every line on stdout must be a JSON-RPC message; one log line corrupts the stream. */
    const stdoutIsClean = (stdout) =>
      stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .every((line) => {
          try {
            return JSON.parse(line).jsonrpc === '2.0';
          } catch {
            return false;
          }
        });

    const fail = (message, run) => {
      console.error(`build-mcpb: FATAL: ${message}`);
      console.error(`  stdout: ${run.stdout.slice(0, 400)}`);
      console.error(`  stderr: ${run.stderr.slice(-800)}`);
      process.exit(1);
    };

    // 3. The manifest's own launch. No browser (FMCODE_NO_BROWSER) and a short
    // sign-in window (FMCODE_LOGIN_TIMEOUT_MS), so a build neither opens a
    // window nor waits out the real redirect timeout.
    const hostRun = await serveAsHost(['--env', 'prod'], {
      FORTMESA_API_TOKEN: '',
      FMCODE_AUTO_LOGIN: 'true',
      FMCODE_NO_BROWSER: 'true',
      FMCODE_LOGIN_TIMEOUT_MS: '2000',
      FORTMESA_DATA_REGION: '',
    });

    if (!hostRun.stdout.includes('"id":1')) {
      fail(
        "the manifest's own launch never answered initialize — this is what an installing user sees as\n" +
          '  "Unable to connect to extension server". A first install has NO credentials, so nothing on the\n' +
          '  startup path may block on obtaining them before the stdio transport is connected.',
        hostRun,
      );
    }
    if (!hostRun.stderr.includes('Starting browser sign-in')) {
      fail(
        'FMCODE_AUTO_LOGIN did not start the CIMD sign-in. An MCPB install has no terminal and no\n' +
          '  Saferoom UI, so browser sign-in is the ONLY way a bundled server ever gets credentials.',
        hostRun,
      );
    }
    if (!/Sign-in URL: https?:\/\//.test(hostRun.stderr)) {
      fail(
        "the sign-in URL never reached stderr — with no browser, that log line is the user's only route to it.",
        hostRun,
      );
    }
    if (!stdoutIsClean(hostRun.stdout)) {
      fail(
        'something that is not JSON-RPC reached STDOUT. Any such byte corrupts the stream and the host drops the server.',
        hostRun,
      );
    }

    // 4. Data region override: one URL has to move the gateway too, not just an
    // API base (registry/environments.ts#deriveDataRegion).
    const regionRun = await serveAsHost(['--env', 'prod'], {
      FORTMESA_API_TOKEN: '',
      FMCODE_AUTO_LOGIN: 'true',
      FMCODE_NO_BROWSER: 'true',
      FMCODE_LOGIN_TIMEOUT_MS: '2000',
      FORTMESA_DATA_REGION: 'https://api.smoke-test.example.com',
    });
    if (!regionRun.stdout.includes('"id":1'))
      fail('a data region override stopped the server from answering initialize.', regionRun);
    if (!regionRun.stderr.includes('https://mcp.smoke-test.example.com/mcp')) {
      fail(
        'a data region override did not re-point the GATEWAY — it would have kept talking to production.',
        regionRun,
      );
    }

    // 5. A rejected override must not become production.
    const badRegionRun = await serveAsHost(['--env', 'prod'], {
      FORTMESA_API_TOKEN: '',
      FMCODE_AUTO_LOGIN: 'true',
      FMCODE_NO_BROWSER: 'true',
      FORTMESA_DATA_REGION: 'ftp://nope',
    });
    if (!badRegionRun.stdout.includes('"id":1')) {
      fail('a rejected data region killed the server instead of leaving one that can explain itself.', badRegionRun);
    }
    if (!badRegionRun.stderr.includes('FortMesa is not configured')) {
      fail('a rejected data region was not reported as such.', badRegionRun);
    }
    if (badRegionRun.stderr.includes('Starting browser sign-in')) {
      fail('a rejected data region still started a sign-in — it must not fall back to production.', badRegionRun);
    }

    console.log(
      'build-mcpb: smoke test OK (env credentials work; the manifest launch answers initialize while ' +
        'signing in; data region override re-points the gateway; a bad one refuses instead of falling back)',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const outPath = parseOutPath();

if (!existsSync(ENTRY_SOURCE)) {
  console.error(`build-mcpb: FATAL: ${ENTRY_SOURCE} is missing. Run \`yarn build:cli\` first.`);
  process.exit(1);
}

const manifest = buildManifest();

// The payload is the whole product here. A manifest pointing at an entry that
// is not in the archive installs cleanly and then fails at first launch, so
// the two are assembled together and the pairing is asserted below.
const entries = [
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8') },
  { name: ENTRY_IN_BUNDLE, data: readFileSync(ENTRY_SOURCE) },
  { name: 'icon.png', data: readFileSync(join(repoRoot, 'media/logo.png')) },
  // Load-bearing, not decoration. `src/shared/version.ts` reads
  // `<__dirname>/../package.json` at MODULE LOAD to resolve VERSION, and
  // __dirname is `server/` inside an installed bundle. Without this file the
  // server throws ENOENT before it can serve a single request. The VSIX never
  // hit this because it ships the real package.json; the first .mcpb did, and
  // only running the extracted bundle showed it.
  //
  // Minimal on purpose: the real manifest is manifest.json, and a full copy
  // would drag the whole `contributes` block and every dependency name in for
  // no reason. No `type` field, because a `.cjs` file is CommonJS by
  // extension regardless.
  {
    name: 'package.json',
    data: Buffer.from(
      `${JSON.stringify({ name: manifest.name, version: manifest.version, private: true }, null, 2)}\n`,
      'utf-8',
    ),
  },
];

const names = new Set(entries.map((entry) => entry.name));
if (!names.has(manifest.server.entry_point)) {
  console.error(`build-mcpb: FATAL: manifest entry_point "${manifest.server.entry_point}" is not in the archive`);
  process.exit(1);
}
if (!names.has(manifest.icon)) {
  console.error(`build-mcpb: FATAL: manifest icon "${manifest.icon}" is not in the archive`);
  process.exit(1);
}

const archive = writeZip(entries);
writeFileSync(outPath, archive);
await smokeTest(entries);

console.log(`build-mcpb: wrote ${outPath}`);
for (const entry of entries) console.log(`  ${entry.name.padEnd(20)} ${String(entry.data.length).padStart(9)} bytes`);
console.log(`  ${'(archive)'.padEnd(20)} ${String(archive.length).padStart(9)} bytes`);
