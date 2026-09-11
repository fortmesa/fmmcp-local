#!/usr/bin/env node
/**
 * Fails the build if a prod-only bundle still contains a non-prod hostname.
 *
 * The prod-only flag works by dead-code elimination: esbuild substitutes
 * `__FORTMESA_PROD_ONLY__` via `--define`, the guarded expressions in
 * `src/registry/environments.ts` fold to literals, and `DEV_ENVIRONMENTS`
 * drops out as unreachable. DCE is a bundler optimization, not a contract,
 * so a bundler upgrade or an innocent-looking refactor (routing the flag
 * through a shared binding, say) can silently reintroduce every string this
 * flag exists to remove. Grepping the built file is the only check that
 * actually proves the removal.
 *
 * Scope: EVERY shipped artifact. `dist-ext/**` (the VSIX bundles), `dist/**`
 * (the npm tarball's CLI), and package.json, which vsce copies in verbatim.
 *
 * It also fails on any surviving `.map` or `.d.ts`. An esbuild sourcemap
 * embeds the full original source, so it hands back every hostname the
 * bundle just dropped, and tsc copies doc comments naming those hosts into
 * declarations. `scripts/package-prod.mjs` deletes both; this is the check
 * that they actually went.
 *
 * Usage: `node scripts/verify-prod-strip.mjs` (no-op unless
 * FORTMESA_PROD_ONLY=true).
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN, SHIPPED_TEXT } from './prod-scrub.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything the VSIX ships that can carry a hostname. The two bundles are
 * esbuild output and get the define; package.json is copied in verbatim by
 * vsce, so its `contributes.configuration` defaults have to be rewritten
 * separately (see scripts/package-prod.mjs) and are checked here for the
 * same reason.
 */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every shipped file, scanned as bytes rather than trusted by construction. */
function shippedFiles() {
  const trees = [...walk(join(repoRoot, 'dist-ext')), ...walk(join(repoRoot, 'dist'))];
  return [...trees.map((f) => relative(repoRoot, f)), 'package.json', ...SHIPPED_TEXT];
}

/**
 * Debug artifacts that must not survive a prod build, checked by extension
 * rather than by content: a `.map` is a verbatim copy of the source, so
 * grepping it is beside the point. It simply must not be there.
 */
const FORBIDDEN_EXTENSIONS = ['.map', '.d.ts'];

// F-5 (security delta, 2026-09-04): this used to exit 0 with a line that READ
// like a pass whenever FORTMESA_PROD_ONLY was unset — which is exactly what the
// default `package:ext` did. A release cut with the shorter, more obvious
// command therefore got none of this file's protection and was told nothing was
// wrong. Silence is the defect, so an UNSET flag is now a hard failure and a
// dev build must say so out loud. This is a guard change, not a logic change:
// what gets verified when the flag IS "true" is untouched.
const prodOnly = process.env.FORTMESA_PROD_ONLY;
if (prodOnly === undefined || prodOnly === '') {
  console.error(
    'verify-prod-strip: FATAL: FORTMESA_PROD_ONLY is unset, so this script cannot say whether the\n' +
      '  artifact is a prod build or a dev build — and exiting 0 here once let a release ship dev\n' +
      '  hostnames and sourcemaps behind a passing-looking line.\n' +
      '  Set FORTMESA_PROD_ONLY=true for a release build (or run `yarn package:ext:prod`),\n' +
      '  or FORTMESA_PROD_ONLY=false to acknowledge an unshippable dev build.',
  );
  process.exit(1);
}
if (prodOnly !== 'true') {
  console.error(
    `verify-prod-strip: FORTMESA_PROD_ONLY="${prodOnly}" — this is a DEV BUILD and NOT a release artifact.\n` +
      '  It ships sandbox/dev hostnames and sourcemaps by design. Do not publish it.\n' +
      '  Use `yarn package:ext:prod` for anything that goes to a user.',
  );
  process.exit(0);
}

let failed = false;
const TARGETS = shippedFiles();

for (const target of TARGETS) {
  if (FORBIDDEN_EXTENSIONS.some((ext) => target.endsWith(ext))) {
    console.error(`verify-prod-strip: FATAL: ${target} is a sourcemap/declaration and must not ship in a prod build.`);
    failed = true;
    continue;
  }

  const path = join(repoRoot, target);

  let contents;
  try {
    contents = await readFile(path, 'utf-8');
  } catch (error) {
    console.error(`verify-prod-strip: FATAL: cannot read ${target}: ${error.message}`);
    failed = true;
    continue;
  }

  const hits = FORBIDDEN.filter((needle) => contents.includes(needle));
  if (hits.length > 0) {
    console.error(`verify-prod-strip: FATAL: ${target} still contains non-prod hostnames: ${hits.join(', ')}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nverify-prod-strip: the prod-only strip did NOT take effect. Do not ship this build.');
  process.exit(1);
}

console.log(`verify-prod-strip: ${String(TARGETS.length)} shipped files scanned, all clean.`);
