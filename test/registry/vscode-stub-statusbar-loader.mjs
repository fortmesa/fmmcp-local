// Test-only `node:module` hook: serves a `vscode` stub rich enough to drive the
// real status-bar item (`createStatusBar`) and the real Signed-in user
// `IdentityViewProvider`, recording what they paint. Registered by
// `status-bar-auth.test.mjs` only. Like its siblings, it touches no source
// file and adds no package to the dependency graph.

const STUBBED_SPECIFIER = 'vscode';
const STUB_URL = 'fmmcp-test-stub:vscode-statusbar';

const SOURCE = `
globalThis.__fmmcpVscodeStub = globalThis.__fmmcpVscodeStub ?? {};
const items = [];
globalThis.__fmmcpVscodeStub.statusBarItems = items;

class ThemeColor {
  constructor(id) { this.id = id; }
}
const StatusBarAlignment = { Left: 1, Right: 2 };

const window = {
  createStatusBarItem: () => {
    const item = { text: '', tooltip: undefined, backgroundColor: undefined, command: undefined, name: undefined,
      show() {}, hide() {}, dispose() {} };
    items.push(item);
    return item;
  },
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined, show: () => undefined }),
};
const commands = { executeCommand: async () => undefined };
const Uri = { parse: (value) => ({ value, toString: () => value }) };
const EventEmitter = class { event = () => ({ dispose() {} }); fire() {} dispose() {} };

export { ThemeColor, StatusBarAlignment, window, commands, Uri, EventEmitter };
export default { ThemeColor, StatusBarAlignment, window, commands, Uri, EventEmitter };
`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === STUBBED_SPECIFIER) return { url: STUB_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === STUB_URL) return { format: 'module', shortCircuit: true, source: SOURCE };
  return nextLoad(url, context);
}
