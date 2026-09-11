import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source of truth for the package version: package.json sits two
// levels above the compiled file (dist/shared/version.js) both in the repo
// checkout and in any bundled/copied layout that preserves the dist/ shape.
// Read once at module load — see fmmcp-gw's src/shared/version.ts for the
// sibling copy of this pattern (curriculum 08-pitfalls-log.md #4).
//
// Dual-path resolution (UX-ROUND-2-PLAN.md W1): this module is compiled
// TWICE — tsc's ESM `dist/` build (real `import.meta.url`) AND esbuild's
// `--format=cjs` bundle for the Saferoom .vsix (`dist-ext/cli.cjs`,
// `yarn build:cli`, imported transitively via `cli.ts`). esbuild replaces
// every `import.meta` expression with `{}` in cjs output — confirmed to
// throw immediately at module load (`fileURLToPath(undefined)`) the first
// time this was tried directly. A `.cjs` output file is CommonJS by
// extension regardless of package.json's `"type": "module"`, so real Node
// CJS globals (`__dirname`) ARE available there natively; that branch is
// checked first and is the one actually taken in the bundle. The
// `import.meta.url` branch below is genuinely dead code in that bundle
// (esbuild still statically warns about it — `empty-import-meta` — since it
// can't prove reachability, but it never executes there) and is exactly
// what runs in the tsc ESM build, where `__dirname` is not defined.
//
// The two branches climb a DIFFERENT number of directories on purpose:
// bundling flattens this file's code into `dist-ext/cli.cjs` itself, which
// sits ONE level below the extension install root (`dist-ext/`); the
// unbundled tsc build compiles this file to `dist/shared/version.js`, TWO
// levels below the repo root (`dist/shared/`).
function resolvePackageJsonPath(): string {
  if (typeof __dirname === 'string') {
    return join(__dirname, '..', 'package.json');
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
}

export const VERSION: string = (JSON.parse(readFileSync(resolvePackageJsonPath(), 'utf-8')) as { version: string })
  .version;
