// MFDV-581: the status bar said "Not signed-in" although the Signed-in user
// sidebar had already detected the expired access token and refreshed it.
//
// Two defects, both asserted here through the REAL entry points -- the status
// bar controller (`createStatusBarController`, which paints the real status
// bar item) and the real `IdentityViewProvider` (the sidebar) -- against a real
// credentials.json in a temp FMCODE_DIR and a local stand-in token endpoint.
// Every assertion reads the result back through a different path than the one
// that produced it (the recorded item text, the recorded webview message, and
// credentials.json re-read from disk).
//
//  H1 (load order): the bar reported auth state from the expired token before
//     anything attempted a refresh.
//  H2 (no notification): a refresh completed by the sidebar never told the bar.
//
// Run against the BUILT output: `yarn build && yarn node --test
// test/registry/status-bar-auth.test.mjs`.

import { register } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./vscode-stub-statusbar-loader.mjs', import.meta.url);

const { createStatusBar, createStatusBarController } = await import('../../dist/extension/status-bar.js');
const { IdentityViewProvider } = await import('../../dist/extension/identity-view.js');
const { loadConfig, saveConfig } = await import('../../dist/registry/config.js');

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (expSeconds) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: expSeconds })}.sig`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const SIGNED_IN_TEXT = '$(fortmesa-logo) GRC: acme';
const log = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {} };

async function waitFor(predicate, what, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/**
 * A fake token endpoint + API. `control.fail` makes the token endpoint 500,
 * which `refreshIfExpiring` reports as a failed (not thrown) refresh.
 */
async function withWorld(fn) {
  const fresh = jwt(nowSeconds() + 3600);
  const control = { fail: false, tokenRequests: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') {
        control.tokenRequests += 1;
        if (control.fail) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: fresh, expires_in: 3600, refresh_token: 'refresh-2' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = await mkdtemp(join(tmpdir(), 'fortmesa-581-'));
  const saved = {
    dir: process.env.FMCODE_DIR,
    issuer: process.env.FMCODE_OAUTH_ISSUER,
    token: process.env.FORTMESA_API_TOKEN,
  };
  process.env.FMCODE_DIR = dir;
  process.env.FMCODE_OAUTH_ISSUER = base;
  delete process.env.FORTMESA_API_TOKEN;

  const expired = jwt(nowSeconds() - 600);
  await writeFile(
    join(dir, 'credentials.json'),
    JSON.stringify({
      environments: {
        next: {
          fortmesa_api_token: expired,
          fortmesa_api_base: base,
          generated_at: 'unknown',
          expires_at: 'unknown',
          fortmesa_refresh_token: 'refresh-1',
        },
      },
    }),
  );
  const config = { ...(await loadConfig()), activeEnv: 'next', scopeLock: { mode: 'single', scopes: ['acme'] } };
  await saveConfig(config);

  globalThis.__fmmcpVscodeStub.statusBarItems.length = 0;
  try {
    return await fn({
      config,
      control,
      fresh,
      readToken: async () =>
        JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf-8')).environments.next.fortmesa_api_token,
    });
  } finally {
    for (const [key, value] of [
      ['FMCODE_DIR', saved.dir],
      ['FMCODE_OAUTH_ISSUER', saved.issuer],
      ['FORTMESA_API_TOKEN', saved.token],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

/** A minimal WebviewView that records every state the sidebar posts. */
function fakeWebviewView() {
  const states = [];
  return {
    states,
    view: {
      webview: {
        options: {},
        html: '',
        cspSource: 'test',
        asWebviewUri: (uri) => uri,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (message) => {
          if (message?.type === 'state') states.push(message.payload);
          return true;
        },
      },
      onDidDispose: () => ({ dispose() {} }),
    },
  };
}

function mount() {
  const statusBar = createStatusBar({ subscriptions: [] });
  const controller = createStatusBarController(statusBar, log);
  const item = globalThis.__fmmcpVscodeStub.statusBarItems[0];
  const provider = new IdentityViewProvider(log);
  const webview = fakeWebviewView();
  provider.resolveWebviewView(webview.view);
  return { controller, item, provider, webview };
}

test('H1: the bar does not report "Not signed-in" from an expired token while a refresh is possible', async () => {
  await withWorld(async ({ config, readToken, fresh }) => {
    const { controller, item } = mount();
    await controller.refresh(config); // first paint, before the sidebar has done anything
    assert.equal(item.text, SIGNED_IN_TEXT);
    assert.equal(item.backgroundColor, undefined, 'no warning background either');
    assert.equal(await readToken(), fresh, 'the refreshed token is what is on disk');
  });
});

test('H2: a refresh completed by the sidebar updates a bar that could not refresh', async () => {
  await withWorld(async ({ config, control, readToken, fresh }) => {
    const { controller, item, provider, webview } = mount();

    control.fail = true; // the token endpoint is briefly down when the bar first looks
    await controller.refresh(config);
    assert.match(item.text, /Not signed-in/, 'nothing could refresh yet, so the bar is honest about that');

    control.fail = false;
    provider.refresh(); // the sidebar retries and succeeds; NO call is made on the status bar
    await waitFor(() => webview.states.length > 0, 'the sidebar to post its state');
    assert.equal(webview.states.at(-1).signedIn, true, 'sidebar: signed in after its refresh');
    assert.equal(await readToken(), fresh);

    await waitFor(() => item.text === SIGNED_IN_TEXT, 'the bar to follow the sidebar refresh');
    assert.equal(item.backgroundColor, undefined);
  });
});

test('one auth state: a refresh started from either surface is one request and both surfaces agree', async () => {
  await withWorld(async ({ config, control }) => {
    const { controller, item, provider, webview } = mount();
    provider.refresh();
    await controller.refresh(config);
    await waitFor(() => webview.states.length > 0, 'the sidebar to post its state');
    await waitFor(() => item.text === SIGNED_IN_TEXT, 'the bar to show the signed-in scope');
    assert.equal(webview.states.at(-1).signedIn, true);
    assert.equal(control.tokenRequests, 1, 'rotation is on: two concurrent refreshes would burn the refresh token');
  });
});
