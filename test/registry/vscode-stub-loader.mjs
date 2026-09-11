// Test-only `node:module` customization hook that stubs the bare specifier
// `vscode` with an empty module namespace object.
//
// Why this exists: `src/extension/settings-sync.ts` has a top-level
// `import * as vscode from 'vscode'`, even though the four functions this
// suite tests (`snapshotFromConfig`, `configFromSnapshot`, `configEquals`,
// `diffSettingsUpdates`) are pure and never touch `vscode.*` at call time —
// see that module's own doc comment. Under plain `yarn node --test` (Yarn
// PnP), `vscode` is not a real resolvable runtime package (only
// `@types/vscode`, types-only, is installed — the real `vscode` module is
// injected by the VS Code extension host at run time), so importing
// `dist/extension/settings-sync.js` directly throws before any exported
// function can even be reached.
//
// This hook intercepts ONLY the specifier `vscode` and serves a trivial
// empty ESM module — enough to satisfy `import * as vscode from 'vscode'`
// (any module namespace object works, since the four functions under test
// never dereference it). Every other specifier passes through untouched via
// `nextResolve`/`nextLoad`. No source file is modified, no fake `vscode`
// package is added to the dependency graph, and no other test file in this
// suite is affected (this loader is registered only by
// settings-sync.test.mjs, which is the only file that needs it).
//
// Registered via `module.register()` (stable Node API, 20.6+/18.19+) from
// settings-sync.test.mjs — see that file's header for the registration call.

const STUBBED_SPECIFIER = 'vscode';
const STUB_URL = 'fmmcp-test-stub:vscode';

export function resolve(specifier, context, nextResolve) {
  if (specifier === STUBBED_SPECIFIER) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default {};',
    };
  }
  return nextLoad(url, context);
}
