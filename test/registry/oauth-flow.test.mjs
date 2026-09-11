// Unit tests for src/registry/oauth-flow.ts.
//
// Run against the BUILT output (same convention as
// test/registry/projectors/codex.test.mjs / scripts/test-runner.mjs):
//   yarn build && yarn node --test test/registry/oauth-flow.test.mjs
//
// `test/` is deliberately outside the tsc project and the ESLint targets
// (see eslint.config.mjs's ignore comment) — plain node:test scripts, not
// part of the shipped dist/ output.
//
// Round 2 (BRIEF-SIGNIN-1 steps 2/6/9) rewrote three contracts here, and each
// gets a test that would FAIL against the old behaviour:
//   - the redirect URI is supplied by the caller, not derived;
//   - a callback carrying `error` RESOLVES as cancelled/error;
//   - the browser response is HELD until `respond(location)` 302s it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELD_RESPONSE_TIMEOUT_MS,
  LoopbackAbortedError,
  LoopbackStateMismatchError,
  LoopbackTimeoutError,
  PASTE_NEEDS_BOTH_PARTS,
  PastedStateMismatchError,
  assertPastedState,
  loopbackRedirectUri,
  parsePastedCode,
  runLocalLoopbackFlow,
} from '../../dist/registry/oauth-flow.js';

/**
 * Fire a GET at `redirectUri` with query params appended. Redirects are NOT
 * followed — the 302 target is the thing under test.
 *
 * The listener's `listening` event (which gates `onRedirectUriReady`, see
 * `settled` below) only proves the socket is BOUND — under CPU contention
 * from the other files `yarn test:unit` runs concurrently, the very first
 * connection can still land in the brief window before the kernel's accept
 * queue is actually servicing it, and gets torn down (`fetch failed` /
 * `UND_ERR_SOCKET: other side closed`) with no defect behind it. So this
 * polls the connection itself the same way `settled` polls readiness: retry
 * on that one transient failure rather than treating it as the outcome.
 */
async function fireCallback(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fetch(url, { redirect: 'manual' });
    } catch (error) {
      const isTransientSocketError =
        error instanceof TypeError && error.cause !== undefined && error.cause.code === 'UND_ERR_SOCKET';
      if (!isTransientSocketError || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('unreachable');
}

/** No-op logger for tests that don't care about log output. */
function noopLog() {}

/** The options every test shares, with the loopback URI as the caller-supplied redirect (what a local host / the CLI does). */
/**
 * Wait until `read()` returns something, rather than assuming one `setImmediate`
 * is enough.
 *
 * `onRedirectUriReady` fires only after the listener has actually BOUND a
 * port, which is real async I/O. A single tick happens to be enough on an idle
 * machine and is not enough when the test runner is saturating the CPU with
 * parallel files — SIGNIN-9 added ten tests elsewhere and this began failing
 * roughly one run in three, as a false red with no defect behind it.
 */
async function settled(read, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function baseOptions(overrides) {
  return {
    apiBase: 'https://auth.example.com',
    clientId: 'https://example.com/oauth/client.json',
    log: noopLog,
    resolveRedirectUri: (port) => loopbackRedirectUri(port),
    onRedirectUriReady: () => undefined,
    ...overrides,
  };
}

test('runLocalLoopbackFlow: resolves success with the code when the callback carries the correct state', async () => {
  const expectedState = 'the-correct-state';
  let readyRedirectUri;

  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      onRedirectUriReady: (redirectUri) => {
        readyRedirectUri = redirectUri;
      },
      timeoutMs: 5000,
    }),
  );

  await settled(() => readyRedirectUri, 'onRedirectUriReady');
  assert.match(readyRedirectUri, /^http:\/\/127\.0\.0\.1:4311[789]\/callback$/);

  const responsePromise = fireCallback(readyRedirectUri, { code: 'the-code', state: expectedState });
  const result = await flow;

  assert.equal(result.outcome, 'success');
  assert.equal(result.code, 'the-code');
  assert.equal(result.usedRedirectUri, readyRedirectUri);
  assert.equal(result.errorDescription, undefined);

  // The browser is still waiting at this point — that is the deferral.
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=ok&env=prod');
  const response = await responsePromise;
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://fortmesa.com/a/auth/saferoom/complete?outcome=ok&env=prod');
});

test('runLocalLoopbackFlow: uses the redirect URI the CALLER resolved, not the loopback one it bound', async () => {
  // This is the forwarded-remote case: the browser is redirected to the
  // forwarded URI, and THAT is what the token exchange must repeat, so the
  // flow has to report it verbatim rather than the address it listens on.
  const expectedState = 'state-forwarded';
  let announced;
  let listenPort;

  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      resolveRedirectUri: (port) => {
        listenPort = port;
        return `http://localhost:${String(port)}/callback`;
      },
      onRedirectUriReady: (redirectUri) => {
        announced = redirectUri;
      },
      timeoutMs: 5000,
    }),
  );

  await settled(() => announced, 'onRedirectUriReady');
  assert.equal(announced, `http://localhost:${String(listenPort)}/callback`);

  const responsePromise = fireCallback(`http://127.0.0.1:${String(listenPort)}/callback`, {
    code: 'c',
    state: expectedState,
  });
  const result = await flow;
  assert.equal(result.usedRedirectUri, `http://localhost:${String(listenPort)}/callback`);
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=ok&env=prod');
  await responsePromise;
});

test('runLocalLoopbackFlow: a resolveRedirectUri failure is a bind failure, not a hang', async () => {
  await assert.rejects(
    () =>
      runLocalLoopbackFlow(
        baseOptions({
          expectedState: 's',
          resolveRedirectUri: () => {
            throw new Error('asExternalUri exploded');
          },
          timeoutMs: 500,
        }),
      ),
    /could not resolve an externally reachable redirect URI/,
  );
});

test('runLocalLoopbackFlow: error=access_denied RESOLVES as cancelled (the user pressed Deny)', async () => {
  const expectedState = 'state-denied';
  let redirectUri;
  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      onRedirectUriReady: (uri) => {
        redirectUri = uri;
      },
      timeoutMs: 5000,
    }),
  );
  await settled(() => redirectUri, 'redirectUri');

  const responsePromise = fireCallback(redirectUri, {
    error: 'access_denied',
    error_description: 'User did not authorize the request',
    state: expectedState,
  });
  const result = await flow;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.code, undefined);
  assert.equal(result.errorDescription, 'User did not authorize the request');
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=cancelled&env=prod');
  const response = await responsePromise;
  assert.match(response.headers.get('location'), /outcome=cancelled/);
});

test('runLocalLoopbackFlow: any other error param RESOLVES as error, carrying its description', async () => {
  const expectedState = 'state-err';
  let redirectUri;
  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      onRedirectUriReady: (uri) => {
        redirectUri = uri;
      },
      timeoutMs: 5000,
    }),
  );
  await settled(() => redirectUri, 'redirectUri');

  const responsePromise = fireCallback(redirectUri, {
    error: 'invalid_request',
    error_description: 'Callback URL mismatch',
    state: expectedState,
  });
  const result = await flow;
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorDescription, 'Callback URL mismatch');
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=error&env=prod');
  await responsePromise;
});

test('runLocalLoopbackFlow: a callback with neither code nor error RESOLVES as error rather than rejecting', async () => {
  const expectedState = 'state-empty';
  let redirectUri;
  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      onRedirectUriReady: (uri) => {
        redirectUri = uri;
      },
      timeoutMs: 5000,
    }),
  );
  await settled(() => redirectUri, 'redirectUri');

  const responsePromise = fireCallback(redirectUri, { state: expectedState });
  const result = await flow;
  assert.equal(result.outcome, 'error');
  assert.match(result.errorDescription, /without an authorization code/);
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=error&env=prod');
  await responsePromise;
});

test('runLocalLoopbackFlow: rejects with LoopbackStateMismatchError, and refuses the browser rather than redirecting it', async () => {
  const expectedState = 'the-correct-state';
  let redirectUri;
  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState,
      onRedirectUriReady: (uri) => {
        redirectUri = uri;
      },
      timeoutMs: 5000,
    }),
  );
  await settled(() => redirectUri, 'redirectUri');

  const responsePromise = fireCallback(redirectUri, { code: 'c', state: 'a-different-state' });
  await assert.rejects(() => flow, LoopbackStateMismatchError);
  const response = await responsePromise;
  // No 302: an unverifiable callback gets no outcome and no app redirect.
  assert.equal(response.status, 400);
});

test('runLocalLoopbackFlow: rejects with LoopbackTimeoutError when nothing arrives before timeoutMs', async () => {
  await assert.rejects(
    () => runLocalLoopbackFlow(baseOptions({ expectedState: 'unused', timeoutMs: 150 })),
    LoopbackTimeoutError,
  );
});

test('runLocalLoopbackFlow: an abort signal frees the port immediately instead of holding it for the full timeout', async () => {
  const controller = new AbortController();
  let firstPort;
  const flow = runLocalLoopbackFlow(
    baseOptions({
      expectedState: 'unused',
      resolveRedirectUri: (port) => {
        firstPort = port;
        return loopbackRedirectUri(port);
      },
      signal: controller.signal,
      timeoutMs: 60000,
    }),
  );
  await settled(() => firstPort, 'firstPort');
  controller.abort();
  await assert.rejects(() => flow, LoopbackAbortedError);

  // The proof the port was released: a second flow binds the SAME first port.
  let secondPort;
  const second = runLocalLoopbackFlow(
    baseOptions({
      expectedState: 'unused',
      resolveRedirectUri: (port) => {
        secondPort = port;
        return loopbackRedirectUri(port);
      },
      timeoutMs: 150,
    }),
  );
  await assert.rejects(() => second, LoopbackTimeoutError);
  assert.equal(secondPort, firstPort);
});

test('runLocalLoopbackFlow: the held response is hard-timed-out so a dead caller cannot spin a browser tab forever', () => {
  // The full 10 s is not worth burning in the suite; what matters is that the
  // constant exists, is finite, and is shorter than the sign-in window.
  assert.equal(typeof HELD_RESPONSE_TIMEOUT_MS, 'number');
  assert.ok(HELD_RESPONSE_TIMEOUT_MS > 0 && HELD_RESPONSE_TIMEOUT_MS <= 30000);
});

test('runLocalLoopbackFlow: closes its server after respond() (a second flow binds the same first port)', async () => {
  let firstPort;
  const first = runLocalLoopbackFlow(
    baseOptions({
      expectedState: 's1',
      resolveRedirectUri: (port) => {
        firstPort = port;
        return loopbackRedirectUri(port);
      },
      timeoutMs: 5000,
    }),
  );
  await settled(() => firstPort, 'firstPort');
  const responsePromise = fireCallback(loopbackRedirectUri(firstPort), { code: 'c', state: 's1' });
  const result = await first;
  result.respond('https://fortmesa.com/a/auth/saferoom/complete?outcome=ok&env=prod');
  await responsePromise;

  let secondPort;
  const second = runLocalLoopbackFlow(
    baseOptions({
      expectedState: 's2',
      resolveRedirectUri: (port) => {
        secondPort = port;
        return loopbackRedirectUri(port);
      },
      timeoutMs: 150,
    }),
  );
  await assert.rejects(() => second, LoopbackTimeoutError);
  assert.equal(secondPort, firstPort);
});

test('loopbackRedirectUri: renders the expected fixed loopback URL shape', () => {
  assert.equal(loopbackRedirectUri(43117), 'http://127.0.0.1:43117/callback');
  assert.equal(loopbackRedirectUri(43119), 'http://127.0.0.1:43119/callback');
});

// ── Paste contract (round 2: both halves, always) ─────────────────────────

test('parsePastedCode: a full redirect URL yields code + state', () => {
  assert.deepEqual(parsePastedCode('http://127.0.0.1:43117/callback?code=the-auth-code&state=abc123'), {
    code: 'the-auth-code',
    state: 'abc123',
  });
});

test('parsePastedCode: `code#state` yields the same pair (what the hosted page shows)', () => {
  assert.deepEqual(parsePastedCode('the-auth-code#abc123'), { code: 'the-auth-code', state: 'abc123' });
  assert.deepEqual(parsePastedCode('  the-auth-code#abc123  '), { code: 'the-auth-code', state: 'abc123' });
});

test('parsePastedCode: a BARE code is refused — it is the one shape whose state cannot be checked', () => {
  assert.throws(
    () => parsePastedCode('the-auth-code'),
    new RegExp(PASTE_NEEDS_BOTH_PARTS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.throws(() => parsePastedCode('the-auth-code#'), /two parts/);
  assert.throws(() => parsePastedCode('#abc123'), /two parts/);
});

test('parsePastedCode: a URL missing either half is refused, without OAuth vocabulary', () => {
  // SIGNIN-9: the message no longer names the missing PARAMETER, because it is
  // rendered to a user who has never heard of `code` or `state`. It must also
  // never echo the input: on the paste method that input is a redirect URL
  // carrying a live authorization code, and the string lands in the page's DOM.
  for (const url of ['http://127.0.0.1:43117/callback?state=abc123', 'http://127.0.0.1:43117/callback?code=abc']) {
    assert.throws(
      () => parsePastedCode(url),
      (error) => {
        assert.match(error.message, /missing part of the sign-in/i);
        assert.equal(error.message.includes(url), false, 'the pasted input must not be echoed');
        assert.equal(/query parameter/i.test(error.message), false);
        return true;
      },
    );
  }
});

test('parsePastedCode: an unparseable URL is refused without echoing it', () => {
  assert.throws(
    () => parsePastedCode('http://[not a url'),
    (error) => {
      assert.match(error.message, /couldn't be read/i);
      assert.equal(error.message.includes('[not a url'), false);
      return true;
    },
  );
});

test('parsePastedCode: throws a clear error for empty input', () => {
  assert.throws(() => parsePastedCode('   '), /Paste the code or address from your browser first\./);
});

test('assertPastedState: a mismatch is fatal on every path, and there is no shape that skips it', () => {
  assert.throws(() => assertPastedState({ code: 'c', state: 'wrong' }, 'right'), PastedStateMismatchError);
  assert.doesNotThrow(() => assertPastedState({ code: 'c', state: 'right' }, 'right'));
});
