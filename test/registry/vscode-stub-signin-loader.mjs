// Test-only `node:module` hook that serves a WORKING (not merely empty)
// `vscode` stub, so `dist/extension/sign-in-session.js` can be exercised
// outside an extension host.
//
// `vscode-stub-loader.mjs` (used by settings-sync / ide-sync tests) serves
// `export default {}` — enough for modules whose tested exports never
// dereference `vscode.*`. The sign-in session DOES dereference it: it fires a
// `vscode.EventEmitter`, parses URIs, opens external links and calls
// `fortmesa.refresh`. Those are exactly the seams a test wants to observe, so
// this stub implements them for real and records the calls on
// `globalThis.__fmmcpVscodeStub` rather than pretending they did not happen.
//
// Only the bare specifier `vscode` is intercepted; everything else passes
// through. No source file is modified and no fake package enters the graph.

const STUBBED_SPECIFIER = 'vscode';
const STUB_URL = 'fmmcp-test-stub:vscode-signin';

const SOURCE = `
const calls = { openExternal: [], clipboard: [], commands: [], asExternalUri: [] };
globalThis.__fmmcpVscodeStub = globalThis.__fmmcpVscodeStub ?? {};
globalThis.__fmmcpVscodeStub.calls = calls;

class EventEmitter {
  #listeners = new Set();
  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of [...this.#listeners]) listener(value);
  }
  dispose() {
    this.#listeners.clear();
  }
}

const Uri = {
  parse: (value) => ({
    value,
    toString: () => value,
  }),
};

const UIKind = { Desktop: 1, Web: 2 };

const env = {
  uiKind: UIKind.Desktop,
  remoteName: undefined,
  openExternal: async (uri) => {
    calls.openExternal.push(uri.toString());
    return true;
  },
  asExternalUri: async (uri) => {
    calls.asExternalUri.push(uri.toString());
    const map = globalThis.__fmmcpVscodeStub.asExternalUri;
    return Uri.parse(typeof map === 'function' ? map(uri.toString()) : uri.toString());
  },
  clipboard: {
    writeText: async (text) => {
      calls.clipboard.push(text);
    },
  },
};

const commands = {
  executeCommand: async (command, ...args) => {
    calls.commands.push([command, ...args]);
  },
};

const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined, show: () => undefined }),
  withProgress: async (_options, task) => task({ report: () => undefined }, { isCancellationRequested: false }),
};

export { EventEmitter, Uri, UIKind, env, commands, window };
export default { EventEmitter, Uri, UIKind, env, commands, window };
`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === STUBBED_SPECIFIER) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return { format: 'module', shortCircuit: true, source: SOURCE };
  }
  return nextLoad(url, context);
}
