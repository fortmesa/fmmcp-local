#!/usr/bin/env node
/**
 * Open the built `.vsix` and `.tgz` and grep every entry inside them.
 *
 * This exists because checking build trees is not the same as checking what
 * ships, and the difference was not theoretical: an earlier version of this
 * flag verified `dist/` and `dist-ext/`, passed, and produced a VSIX
 * containing `launch-mcp.sh`, `README.md`, and two docs that all named
 * internal hostnames. The packaged archive is the only thing that answers
 * "what does the user receive", so it is what gets checked.
 *
 * `verify-prod-strip.mjs` still runs earlier as a fast fail. This is the
 * authority.
 *
 * Usage: node scripts/verify-prod-artifacts.mjs <artifact> [artifact...]
 */

import { existsSync, readFileSync } from 'node:fs';
import { readTgz, readZip } from './archive.mjs';
import { FORBIDDEN } from './prod-scrub.mjs';

/**
 * [path, contents] for every entry in the archive.
 *
 * Read with `scripts/archive.mjs` rather than `unzip`/`tar`. CI runs
 * `node:24` fully offline and neither tool is guaranteed there, and for the
 * RELEASE verifier a missing tool is the worst possible failure mode: it
 * either aborts the build or, if it were allowed to skip, reports "clean" for
 * an artifact nobody read.
 */
function entriesOf(artifact) {
  const bytes = readFileSync(artifact);
  // `.mcpb` is a zip, same as `.vsix`.
  if (artifact.endsWith('.vsix') || artifact.endsWith('.mcpb')) return readZip(bytes);
  if (artifact.endsWith('.tgz')) return readTgz(bytes);
  throw new Error(`don't know how to read ${artifact} (expected .vsix, .mcpb or .tgz)`);
}

const artifacts = process.argv.slice(2);
if (artifacts.length === 0) {
  console.error('usage: node scripts/verify-prod-artifacts.mjs <artifact> [artifact...]');
  process.exit(1);
}

let failed = false;

for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    console.error(`verify-prod-artifacts: FATAL: ${artifact} does not exist`);
    failed = true;
    continue;
  }

  const entries = entriesOf(artifact);
  let dirty = 0;

  for (const { name, data } of entries) {
    const contents = data.toString('utf-8');
    if (name.endsWith('.map') || name.endsWith('.d.ts')) {
      console.error(`verify-prod-artifacts: FATAL: ${artifact} ships ${name} (sourcemap/declaration)`);
      failed = true;
      dirty++;
      continue;
    }
    const hits = FORBIDDEN.filter((needle) => contents.includes(needle));
    if (hits.length > 0) {
      console.error(`verify-prod-artifacts: FATAL: ${artifact} -> ${name} contains ${hits.join(', ')}`);
      failed = true;
      dirty++;
    }
  }

  if (dirty === 0) {
    console.log(`verify-prod-artifacts: OK  ${artifact} (${String(entries.length)} entries, all clean)`);
  }
}

if (failed) {
  console.error('\nverify-prod-artifacts: release artifacts are NOT clean. Do not publish.');
  process.exit(1);
}
