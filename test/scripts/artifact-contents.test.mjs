// No test file may ship inside a published artifact.
//
// Three artifacts leave this repo and each decides its own contents:
//   - the npm tarball (.npmignore, a pure allowlist)
//   - the VSIX (.vscodeignore, a pure denylist)
//   - the .mcpb (scripts/build-mcpb.mjs, one esbuild bundle)
//
// The tarball is the one that bites. Its allowlist negates whole subtrees
// (`!dist/local-mcp/**`, `!dist/registry/**`, `!dist/shared/**`), and tsc
// compiles `src/**/*.test.ts` straight into them, so a TypeScript test placed
// next to its subject is published to npm consumers. Five of them were, until
// the suites moved to `test/**/*.test.mjs` on 2026-09-10. Nothing warned.
//
// These assert against what the packers actually emit, not against the ignore
// files, because reading an ignore file only proves what someone intended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join, relative, sep } from 'node:path';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The committed Yarn release, found by glob rather than by version, the same
 * way bitbucket-pipelines.yml resolves it - a Yarn bump renames this file and
 * a hardcoded name would fail the suite for no real reason.
 */
async function resolveYarnBin() {
  const dir = join(repoRoot, '.yarn', 'releases');
  const entries = await readdir(dir);
  const release = entries.find((name) => /^yarn-.*\.cjs$/.test(name));
  assert.ok(release !== undefined, `no yarn release binary in ${dir}`);
  return join(dir, release);
}

/** Anything a reader would call a test: the file, or a directory that holds them. */
function looksLikeTest(path) {
  const p = path.split(sep).join('/');
  return /(^|\/)__tests__\//.test(p) || /(^|\/)test\//.test(p) || /\.test\.[cm]?[jt]s$/.test(p);
}

async function runYarn(args) {
  const { stdout } = await execFileAsync(process.execPath, [await resolveYarnBin(), ...args], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

// -- the npm tarball -------------------------------------------------------

test('npm tarball: ships no test file', async () => {
  // `pack --dry-run` is the packer itself, so this reflects the published
  // tarball rather than a reading of .npmignore.
  const stdout = await runYarn(['pack', '--dry-run']);
  const files = stdout
    .split('\n')
    .map((line) => line.replace(/^.*?YN0000:\s*/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Package archive') && line.includes('/'));

  // Guard against a vacuous pass: an unbuilt dist would list almost nothing
  // and every assertion below would hold for the wrong reason.
  assert.ok(
    files.includes('dist/local-mcp/cli.js'),
    'expected the CLI entry in the tarball - run `yarn build` first, or the check below proves nothing',
  );

  const leaked = files.filter(looksLikeTest);
  assert.deepEqual(leaked, [], `test files in the npm tarball: ${leaked.join(', ')}`);
});

test('npm tarball: a .test.js under an allowlisted dist subtree WOULD ship', async () => {
  // The negative control for the test above. If this ever stops holding, the
  // allowlist gained a re-exclusion and the guard above can be relaxed - but
  // until then, nothing except file placement keeps tests out of the tarball,
  // which is what makes `src/**/*.test.ts` unsafe.
  const { writeFile, rm } = await import('node:fs/promises');
  const probe = join(repoRoot, 'dist', 'local-mcp', '__packprobe.test.js');
  await writeFile(probe, '// packaging probe\n');
  try {
    const stdout = await runYarn(['pack', '--dry-run']);
    assert.match(
      stdout,
      /dist\/local-mcp\/__packprobe\.test\.js/,
      'the allowlist no longer ships dist test files - update the comment on the placement rule below',
    );
  } finally {
    await rm(probe, { force: true });
  }
});

// -- the source-side rule that keeps the tarball clean ---------------------

test('no test file sits under src/ where tsc would compile it into dist/', async () => {
  // The whole reason the tarball stays clean. tsc emits `src/x/y.test.ts` to
  // `dist/x/y.test.js`, which the allowlist then publishes. Tests belong in
  // `test/**/*.test.mjs`, which tsc never reads and no artifact includes.
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // .mjs is not compiled by tsc, so it never reaches dist and cannot ship.
      if (/\.test\.[cm]?ts$/.test(entry.name)) offenders.push(relative(repoRoot, full));
    }
  }
  await walk(join(repoRoot, 'src'));
  assert.deepEqual(
    offenders,
    [],
    `move these to test/**/*.test.mjs - tsc compiles them into dist/ and the npm allowlist publishes them: ${offenders.join(', ')}`,
  );
});

// -- the VSIX --------------------------------------------------------------

test('VSIX: ships no test file', async () => {
  // `vsce ls` applies .vscodeignore exactly as `vsce package` does.
  // `--no-dependencies` matches what `package:ext` passes, and is required:
  // without it vsce shells out to `yarn list --prod --json`, which is Yarn 1
  // syntax that Yarn 4 rejects, and the command dies before listing anything.
  const { stdout } = await execFileAsync(
    process.execPath,
    [await resolveYarnBin(), 'vsce', 'ls', '--no-dependencies'],
    {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('DONE') && !line.startsWith('WARNING'));

  assert.ok(files.includes('package.json'), 'expected a real vsce file listing, got none');

  const leaked = files.filter(looksLikeTest);
  assert.deepEqual(leaked, [], `test files in the VSIX: ${leaked.join(', ')}`);
});

// -- the .mcpb -------------------------------------------------------------

test('mcpb: the payload is the self-contained bundle, never the dist tree', async () => {
  // esbuild only emits what the entry reaches, and no test is imported, so the
  // bundle cannot carry one. That property depends on the payload staying a
  // bundle: pointing ENTRY_SOURCE at dist/ would pull the whole tree in,
  // tests included.
  const builder = await readFile(join(repoRoot, 'scripts', 'build-mcpb.mjs'), 'utf-8');
  const entry = /const ENTRY_SOURCE = join\(repoRoot, '([^']+)'\)/.exec(builder);
  assert.ok(entry !== null, 'ENTRY_SOURCE moved - re-point this test at the payload');
  assert.equal(entry[1], 'dist-ext/cli.cjs');
});

test('mcpb: the built bundle carries no test code', async () => {
  // Only meaningful once `yarn build:cli` has run; skipped otherwise rather
  // than passing vacuously.
  const bundle = join(repoRoot, 'dist-ext', 'cli.cjs');
  const exists = await stat(bundle).then(
    () => true,
    () => false,
  );
  if (!exists) {
    test.skip('dist-ext/cli.cjs not built (yarn build:cli)');
    return;
  }
  const text = await readFile(bundle, 'utf-8');
  assert.ok(!text.includes('node:test'), 'the bundle imports node:test, so a test was reachable from the CLI entry');
});
