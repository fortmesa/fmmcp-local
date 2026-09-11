#!/usr/bin/env node
/**
 * Build the prod-only release artifacts: the Saferoom VSIX, the npm tarball,
 * and the MCP Bundle. Prod is the only environment in any of them, and the
 * sandbox/next/latest hostnames are absent from the shipped files rather than
 * merely unreachable at runtime.
 *
 * Two surfaces carry those hostnames, and they need different treatment:
 *
 *   1. The esbuild bundles. `FORTMESA_PROD_ONLY=true` reaches esbuild's
 *      `--define`, the guarded expressions in `src/registry/environments.ts`
 *      fold to literals, and dead-code elimination drops DEV_ENVIRONMENTS.
 *   2. package.json. vsce copies the manifest in verbatim, so the
 *      `contributes.configuration` defaults have to be rewritten on disk
 *      before packaging. This script does that, then puts the original back
 *      in a `finally` so a failed build never leaves a rewritten manifest
 *      behind.
 *
 * The restore writes back the exact bytes read at startup, which keeps CI's
 * version stamp intact: the pipeline seds package.json before calling this,
 * and reverting through git would throw that edit away.
 *
 *   3. `dist/**`, which the npm tarball ships. `tsc` performs no dead-code
 *      elimination and no `--define`, so the emitted
 *      `dist/registry/environments.js` is re-run through esbuild's transform
 *      with the same define, which folds the ternaries and drops
 *      DEV_ENVIRONMENTS from that one file.
 *
 * Sourcemaps and declarations are deleted rather than stripped. An esbuild
 * `.map` embeds the full original source, so a prod bundle's map hands back
 * every hostname the bundle just removed, and `tsc` copies doc comments into
 * `.d.ts` (which name the dev hosts in prose). A `bin`-only package needs
 * neither at runtime, and the package declares no `types` entry, so nothing
 * consumes them.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_TEXT, scrubText } from './prod-scrub.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'package.json');

/** Run a command, inheriting stdio, and abort the whole script if it fails. */
function run(command, args, extraEnv = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`);
  }
}

/**
 * Post-process tsc's `dist/**` so it carries no non-prod hostname, in values
 * or in prose.
 *
 * `tsc` applies no `--define` and no dead-code elimination, so every module
 * comes out with `__FORTMESA_PROD_ONLY__` still in it and `DEV_ENVIRONMENTS`
 * fully intact. Re-running the emitted JS through esbuild fixes both, but the
 * two halves need different flags:
 *
 *   - `registry/environments.js` holds the hostnames as VALUES. Folding the
 *     ternaries is not enough; the dead branch has to be tree-shaken, and
 *     esbuild only tree-shakes when bundling. `--bundle --minify-syntax` was
 *     measured as the combination that removes it. `--minify-syntax` alone
 *     leaves `DEV_ENVIRONMENTS` declared and every URL present. Bundling this
 *     one file is structurally a no-op because it imports nothing.
 *
 *   - Every other module holds them only in DOC COMMENTS (cli.js's usage
 *     examples, oauth-provider.js's note about API identifiers). Those still
 *     ship the strings. A plain transform drops comments while leaving the
 *     import graph alone, which the npm tarball depends on: it ships an
 *     unbundled module tree, so bundling these would collapse it.
 */
function stripDistTree() {
  const environments = join(repoRoot, 'dist/registry/environments.js');
  console.log('\npackage-prod: stripping dist/registry/environments.js (values)');
  run('yarn', [
    'esbuild',
    environments,
    '--define:__FORTMESA_PROD_ONLY__=true',
    '--bundle',
    '--minify-syntax',
    '--format=esm',
    '--platform=node',
    `--outfile=${environments}`,
    '--allow-overwrite',
  ]);

  const others = collect(join(repoRoot, 'dist'), ['.js']).filter((file) => file !== environments);
  console.log(`package-prod: stripping comments from ${String(others.length)} further dist modules`);
  for (const file of others) {
    run('yarn', [
      'esbuild',
      file,
      '--define:__FORTMESA_PROD_ONLY__=true',
      '--format=esm',
      '--platform=node',
      `--outfile=${file}`,
      '--allow-overwrite',
    ]);
  }
}

/** Every file under `dir` whose name ends in one of `suffixes`, recursively. */
function collect(dir, suffixes) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(full);
  }
  return found;
}

/**
 * Delete sourcemaps and type declarations from both build trees, and drop the
 * now-dangling `sourceMappingURL` comments that would point at them.
 */
function dropSourcemapsAndDeclarations() {
  const doomed = [
    ...collect(join(repoRoot, 'dist'), ['.js.map', '.d.ts', '.d.ts.map']),
    ...collect(join(repoRoot, 'dist-ext'), ['.map']),
  ];
  for (const path of doomed) rmSync(path, { force: true });
  console.log(`\npackage-prod: removed ${String(doomed.length)} sourcemap/declaration files`);

  for (const path of [...collect(join(repoRoot, 'dist'), ['.js']), ...collect(join(repoRoot, 'dist-ext'), ['.cjs'])]) {
    const before = readFileSync(path, 'utf-8');
    const after = before.replace(/^\/\/# sourceMappingURL=.*$/gm, '').replace(/\n+$/, '\n');
    if (after !== before) writeFileSync(path, after, 'utf-8');
  }
}

/**
 * Every file this script edits in place, remembered as bytes so the `finally`
 * can put them back exactly. Restoring through git would work for the docs
 * but not for package.json: CI seds the version into it before calling this,
 * and a git restore would throw that stamp away.
 */
const snapshots = new Map();

function snapshotAndWrite(relativePath, transform) {
  const full = join(repoRoot, relativePath);
  const before = readFileSync(full, 'utf-8');
  snapshots.set(full, before);
  const after = transform(before);
  if (after !== before) writeFileSync(full, after, 'utf-8');
  return after !== before;
}

const originalManifest = readFileSync(manifestPath, 'utf-8');
snapshots.set(manifestPath, originalManifest);

try {
  const pkg = JSON.parse(originalManifest);
  const properties = pkg.contributes?.configuration?.properties;
  if (properties === undefined) {
    throw new Error('package.json has no contributes.configuration.properties to rewrite');
  }

  const environmentsDefault = properties['fortmesa.environments']?.default;
  if (environmentsDefault?.prod === undefined) {
    throw new Error('package.json fortmesa.environments default has no "prod" entry');
  }

  properties['fortmesa.environments'].default = { prod: environmentsDefault.prod };
  properties['fortmesa.activeEnv'].default = 'prod';

  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log('package-prod: manifest rewritten to prod-only defaults');

  // launch-mcp.sh, README.md, CHANGELOG.md and docs/** all ship, and all
  // carried dev.fort.blue / mesa.red examples.
  const scrubbed = SHIPPED_TEXT.filter((file) => snapshotAndWrite(file, scrubText));
  console.log(`package-prod: scrubbed non-prod hostnames from ${String(scrubbed.length)} shipped text file(s)`);

  const prodEnv = { FORTMESA_PROD_ONLY: 'true' };
  const version = pkg.version;

  run('yarn', ['build'], prodEnv);
  stripDistTree();
  run('yarn', ['build:ext'], prodEnv);
  run('yarn', ['build:cli'], prodEnv);
  dropSourcemapsAndDeclarations();
  run('yarn', ['verify:prod-strip'], prodEnv);
  run('yarn', ['notices:check']);
  // No -prod suffix. These are the release artifacts, and a release is always
  // prod, built from main in GitHub Actions. A dev `package:ext` build never
  // runs in that checkout, so there is nothing here to collide with, and a
  // suffix on a public download tells the person downloading it nothing.
  const vsix = `FortMesa-Saferoom-${version}.vsix`;
  const tarball = `fmmcp-local-${version}.tgz`;
  const mcpb = `FortMesa-Saferoom-${version}.mcpb`;

  run('yarn', ['vsce', 'package', '--no-dependencies', '--no-rewrite-relative-links', '-o', vsix]);

  // npmjs is production too, so the tarball is built and checked here rather
  // than left to a separate step that might skip the prod flag.
  run('yarn', ['pack', '-o', tarball]);

  // The .mcpb wraps dist-ext/cli.cjs, already built above with the prod
  // define, so it inherits the strip. Built here rather than in a separate
  // step that could be run without the flag.
  run('yarn', ['node', 'scripts/build-mcpb.mjs', '--out', mcpb], prodEnv);

  // The authority. Everything above inspects build trees; this reads the
  // archives a user actually receives.
  run('yarn', ['node', 'scripts/verify-prod-artifacts.mjs', vsix, tarball, mcpb]);

  console.log(`\npackage-prod: built ${vsix}, ${tarball} and ${mcpb} (prod-only, artifacts verified)`);
} finally {
  for (const [full, contents] of snapshots) writeFileSync(full, contents, 'utf-8');
  console.log(`package-prod: restored ${String(snapshots.size)} source file(s)`);
}
