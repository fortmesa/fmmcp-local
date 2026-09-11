#!/usr/bin/env node
// Generates THIRD-PARTY-NOTICES.md from the ACTUAL production dependency
// graph — the packages esbuild bundles into dist-ext/extension.cjs and
// dist-ext/cli.cjs (build:ext / build:cli use --external:vscode only; every
// other import, direct or transitive, is inlined into the bundle).
//
// Do NOT hand-edit THIRD-PARTY-NOTICES.md. Re-run `yarn notices:generate`
// after any change to "dependencies" in package.json (never devDependencies —
// those are build/test-only and never reach the bundle).
//
// Source of truth: `pnpapi`, queried for every locator reachable from the
// root workspace whose name matches the production dependency closure
// (`yarn info --recursive --json '*' '@*/*'` against a project with ONLY
// "dependencies" installed would show this same set — devDependencies are
// not part of this recursive walk because pnpapi's tree already resolves
// per-package, not per-script; we filter to non-dev by walking outward from
// the "dependencies" field only, never devDependencies).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

const pnpPath = path.join(repoRoot, '.pnp.cjs');
if (!fs.existsSync(pnpPath)) {
  console.error('generate-third-party-notices: .pnp.cjs not found — run `yarn install` first.');
  process.exit(1);
}
require(pnpPath).setup();
const pnp = require('pnpapi');

const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const rootDeps = Object.keys(pkgJson.dependencies || {});

// Walk the pnp dependency graph starting from the root workspace, following
// only "dependencies" edges (pnpapi's per-locator dependency list already
// reflects each package's own runtime deps, not devDependencies — the ONLY
// place devDependencies could leak in is the root locator itself, so we
// seed the walk from package.json's "dependencies" field explicitly rather
// than from the root locator's full dependency list).
const rootLocator = pnp.findPackageLocator(repoRoot + path.sep);
const rootInfo = pnp.getPackageInformation(rootLocator);

const visited = new Map(); // name -> locator (first-seen version)
const queue = [];
for (const depName of rootDeps) {
  const ref = rootInfo.packageDependencies.get(depName);
  if (!ref) {
    console.error(`generate-third-party-notices: root dependency "${depName}" not resolved by PnP.`);
    process.exit(1);
  }
  queue.push({ name: depName, reference: ref });
}

while (queue.length) {
  const loc = queue.shift();
  if (!loc.reference) continue; // native/aliased peer with no resolution
  const key = `${loc.name}@${loc.reference}`;
  if (visited.has(key)) continue;
  visited.set(key, loc);
  const info = pnp.getPackageInformation(loc);
  for (const [depName, depRef] of info.packageDependencies) {
    if (!depRef) continue;
    if (depName === pkgJson.name) continue;
    queue.push({ name: depName, reference: depRef });
  }
}

const entries = [];
for (const loc of visited.values()) {
  const info = pnp.getPackageInformation(loc);
  const pjPath = path.join(info.packageLocation, 'package.json');
  const data = JSON.parse(fs.readFileSync(pjPath, 'utf8'));

  let license = data.license;
  if (!license && Array.isArray(data.licenses)) {
    license = data.licenses.map((l) => l.type).join(' OR ');
  }
  if (!license) license = 'UNKNOWN';
  if (typeof license === 'object' && license.type) license = license.type;

  let author = '';
  if (typeof data.author === 'string') author = data.author;
  else if (data.author && data.author.name) author = data.author.name;

  // Look for a bundled license text file (LICENSE, LICENSE.md, LICENSE.txt,
  // COPYING, etc.) shipped inside the package itself.
  let licenseFile = null;
  try {
    const files = fs.readdirSync(info.packageLocation);
    licenseFile = files.find((f) => /^(LICEN[CS]E|COPYING)(\..*)?$/i.test(f)) || null;
  } catch {
    licenseFile = null;
  }

  entries.push({
    name: data.name,
    version: data.version,
    license,
    author,
    repository: typeof data.repository === 'string' ? data.repository : data.repository?.url || '',
    licenseFile,
    licenseFileLocation: licenseFile ? path.join(info.packageLocation, licenseFile) : null,
  });
}

entries.sort((a, b) => a.name.localeCompare(b.name));

const lines = [];
lines.push('<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->');
lines.push('<!-- Run `yarn notices:generate` (scripts/release/generate-third-party-notices.mjs) -->');
lines.push('<!-- Source: production dependency graph reachable from package.json\'s "dependencies", -->');
lines.push('<!-- resolved via pnpapi — the same packages esbuild bundles into dist-ext/*.cjs. -->');
lines.push('');
lines.push('# Third-Party Notices');
lines.push('');
lines.push(
  'FortMesa Saferoom bundles the following third-party packages into its packaged ' +
    'extension host and CLI (`dist-ext/extension.cjs`, `dist-ext/cli.cjs`). Each is used ' +
    'under the terms of its own license, reproduced or pointed to below.',
);
lines.push('');
lines.push(`_Generated from ${entries.length} production dependencies._`);
lines.push('');

for (const e of entries) {
  lines.push(`## ${e.name}@${e.version}`);
  lines.push('');
  lines.push(`- **License**: ${e.license}`);
  if (e.author) lines.push(`- **Copyright / Author**: ${e.author}`);
  if (e.repository) lines.push(`- **Repository**: ${e.repository}`);
  if (e.licenseFile) {
    const text = fs.readFileSync(e.licenseFileLocation, 'utf8').trim();
    lines.push(`- **License text** (from package's \`${e.licenseFile}\`):`);
    lines.push('');
    lines.push('```');
    lines.push(text);
    lines.push('```');
  } else {
    lines.push(
      `- **License text**: not bundled by the package; see the standard ${e.license} license text ` +
        `(e.g. https://opensource.org/licenses/${encodeURIComponent(e.license)}) or the repository above.`,
    );
  }
  lines.push('');
}

const outPath = path.join(repoRoot, 'THIRD-PARTY-NOTICES.md');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`generate-third-party-notices: wrote ${outPath} (${entries.length} packages).`);
