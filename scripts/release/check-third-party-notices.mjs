#!/usr/bin/env node
// Fails (non-zero exit) if THIRD-PARTY-NOTICES.md is stale relative to the
// current production dependency graph. Run before packaging.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const noticesPath = path.join(repoRoot, 'THIRD-PARTY-NOTICES.md');

if (!fs.existsSync(noticesPath)) {
  console.error('check-third-party-notices: THIRD-PARTY-NOTICES.md is missing. Run `yarn notices:generate`.');
  process.exit(1);
}

const before = fs.readFileSync(noticesPath, 'utf8');

execFileSync(process.execPath, [path.join(repoRoot, 'scripts/release/generate-third-party-notices.mjs')], {
  stdio: 'inherit',
});

const after = fs.readFileSync(noticesPath, 'utf8');

if (before !== after) {
  // Restore the committed version so this check is non-destructive on failure.
  fs.writeFileSync(noticesPath, before);
  console.error(
    'check-third-party-notices: THIRD-PARTY-NOTICES.md is STALE — it does not match the ' +
      'current production dependency graph. Run `yarn notices:generate` and commit the result.',
  );
  process.exit(1);
}

console.log('check-third-party-notices: THIRD-PARTY-NOTICES.md is up to date.');
