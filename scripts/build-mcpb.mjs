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

import { spawnSync } from 'node:child_process';
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
     * That leaves the environment as the only thing worth asking a user.
     */
    user_config: {
      environment: {
        type: 'string',
        title: 'Environment',
        description: 'Which FortMesa environment to connect to. Sign-in opens in your browser on first use.',
        default: 'prod',
        required: true,
      },
      api_base: {
        type: 'string',
        title: 'API Base URL (optional)',
        description: 'Only for a custom deployment. Leave blank to use the selected environment default.',
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
        args: [`\${__dirname}/${ENTRY_IN_BUNDLE}`, '--env', '\${user_config.environment}'],
        env: {
          // Turns on the browser sign-in described above. Set ONLY here: a
          // proxy started from a shell or an IDE must never pop a browser on
          // its own.
          FMCODE_AUTO_LOGIN: 'true',
          // Blank is ignored by resolveCredentials, which then falls back to
          // the selected environment's own base.
          FORTMESA_API_BASE: '\${user_config.api_base}',
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
 * Two runs, because they catch different breakage:
 *
 *   1. NO credentials. Must fail, and must fail on credentials. This is the
 *      exact shape of the shipped bug.
 *   2. WITH a token and `--env prod`, pointed at a closed port. Must get PAST
 *      credential resolution and die trying to reach the gateway. That proves
 *      config bootstrap, environment selection, API-base resolution and the
 *      env-var credential branch all work on a machine with no `~/.fmcode`,
 *      which is every MCPB install.
 *
 * Run 2 deliberately stops at the network boundary. Going further would mean
 * a real gateway, and a build must not depend on one.
 */
function smokeTest(entries) {
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

    // The path the manifest actually uses. No browser (FMCODE_NO_BROWSER) and
    // a short window (FMCODE_LOGIN_TIMEOUT_MS), so a build neither opens a
    // window nor waits out the real redirect timeout.
    const autoLogin = start(['--env', 'prod', '--gateway', 'http://127.0.0.1:1/mcp'], {
      FORTMESA_API_TOKEN: '',
      FMCODE_AUTO_LOGIN: 'true',
      FMCODE_NO_BROWSER: 'true',
      FMCODE_LOGIN_TIMEOUT_MS: '2000',
    });
    const autoStderr = `${autoLogin.stderr}`;

    if (!autoStderr.includes('Starting browser sign-in')) {
      console.error('build-mcpb: FATAL: FMCODE_AUTO_LOGIN did not start the CIMD sign-in.');
      console.error('  The manifest relies on this: an MCPB install has no terminal and no Saferoom UI,');
      console.error('  so browser sign-in is the ONLY way a bundled server ever gets credentials.');
      console.error(`  stderr: ${autoStderr.slice(0, 400)}`);
      process.exit(1);
    }
    if (!/Sign-in URL: https?:\/\//.test(autoStderr)) {
      console.error('build-mcpb: FATAL: the sign-in URL never reached stderr.');
      console.error("  With no browser and no terminal, that log line is the user's only route to it.");
      console.error(`  stderr: ${autoStderr.slice(0, 400)}`);
      process.exit(1);
    }
    if (autoLogin.stdout.trim() !== '') {
      console.error('build-mcpb: FATAL: the sign-in path wrote to STDOUT, which is the JSON-RPC channel.');
      console.error('  Any byte here corrupts the stream and the host drops the server.');
      console.error(`  stdout: ${autoLogin.stdout.slice(0, 400)}`);
      process.exit(1);
    }

    console.log('build-mcpb: smoke test OK (env credentials work; CIMD sign-in starts; stdout stays clean)');
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
smokeTest(entries);

console.log(`build-mcpb: wrote ${outPath}`);
for (const entry of entries) console.log(`  ${entry.name.padEnd(20)} ${String(entry.data.length).padStart(9)} bytes`);
console.log(`  ${'(archive)'.padEnd(20)} ${String(archive.length).padStart(9)} bytes`);
