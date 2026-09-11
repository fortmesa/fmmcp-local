import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCredentials } from '../../dist/local-mcp/auth/token-provider.js';

/**
 * The credential chain picks the token AND the host it is sent to. Sending a
 * prod token to another environment's API is the failure that matters here,
 * so the base-URL precedence is pinned rather than left to reading.
 *
 * Everything runs against a temporary FMCODE_DIR, so no test reads or writes
 * the developer's real ~/.fmcode/credentials.json. Nothing reaches the
 * network either: refreshIfExpiring only calls out when the token is inside
 * its 5 minute lead AND a refresh token is on disk, and no fixture here
 * stores one.
 */

/** A JWT-shaped token whose exp is `secondsFromNow`. Unsigned; nothing in this path verifies it. */
function tokenExpiringIn(secondsFromNow) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;
}

/** A credentials.json env block. Every field is required by the schema, so omitting one makes the whole file unparseable. */
function block(overrides = {}) {
  return {
    fortmesa_api_token: tokenExpiringIn(3600),
    fortmesa_api_base: 'https://file.example',
    generated_at: '2026-09-01T00:00:00.000Z',
    expires_at: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Run `body` with FMCODE_DIR pointed at a fresh temp dir holding
 * `environments`, and with both FORTMESA_ env vars cleared. `env` seeds them
 * for the cases that need them.
 */
async function withCredentials(setup, body) {
  const dir = mkdtempSync(join(tmpdir(), 'fmcode-test-'));
  const prior = {
    FMCODE_DIR: process.env.FMCODE_DIR,
    FORTMESA_API_TOKEN: process.env.FORTMESA_API_TOKEN,
    FORTMESA_API_BASE: process.env.FORTMESA_API_BASE,
  };
  if (setup.raw !== undefined) {
    writeFileSync(join(dir, 'credentials.json'), setup.raw);
  } else if (setup.environments !== undefined) {
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ environments: setup.environments }));
  }
  process.env.FMCODE_DIR = dir;
  delete process.env.FORTMESA_API_TOKEN;
  delete process.env.FORTMESA_API_BASE;
  for (const [key, value] of Object.entries(setup.env ?? {})) process.env[key] = value;
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      // Reflect.deleteProperty rather than `delete process.env[key]`: the
      // dynamic-delete lint rule forbids the operator on a computed key.
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the environment variable wins over the credentials file', async () => {
  const envToken = tokenExpiringIn(3600);
  await withCredentials({ environments: { next: block() }, env: { FORTMESA_API_TOKEN: envToken } }, async () => {
    const creds = await resolveCredentials('next');
    assert.equal(creds.source, 'env');
    assert.equal(creds.token, envToken);
  });
});

test('an env token with no file falls back to the SELECTED environment, not the global default', async () => {
  // The regression this guards: on a fresh machine with FORTMESA_API_TOKEN
  // set, `--env next` used to resolve to production's API base.
  await withCredentials({ env: { FORTMESA_API_TOKEN: tokenExpiringIn(3600) } }, async () => {
    assert.equal((await resolveCredentials('next')).baseUrl, 'https://api-next.dev.fort.blue');
    assert.equal((await resolveCredentials('latest')).baseUrl, 'https://api-latest.dev.fort.blue');
  });
});

test('an unknown environment with an env token still lands on the default base', async () => {
  await withCredentials({ env: { FORTMESA_API_TOKEN: tokenExpiringIn(3600) } }, async () => {
    assert.equal((await resolveCredentials('someones-custom-env')).baseUrl, 'https://api.fortmesa.com');
  });
});

test('the file base outranks the built-in environment base', async () => {
  await withCredentials(
    { environments: { next: block() }, env: { FORTMESA_API_TOKEN: tokenExpiringIn(3600) } },
    async () => {
      assert.equal((await resolveCredentials('next')).baseUrl, 'https://file.example');
    },
  );
});

test('an explicit FORTMESA_API_BASE outranks everything', async () => {
  await withCredentials(
    {
      environments: { next: block() },
      env: { FORTMESA_API_TOKEN: tokenExpiringIn(3600), FORTMESA_API_BASE: 'https://env.example' },
    },
    async () => {
      assert.equal((await resolveCredentials('next')).baseUrl, 'https://env.example');
    },
  );
});

test('with no env token the file supplies token, base and cached expiry', async () => {
  const token = tokenExpiringIn(3600);
  await withCredentials(
    { environments: { next: block({ fortmesa_api_token: token, expires_at: '2026-12-25T00:00:00.000Z' }) } },
    async () => {
      const creds = await resolveCredentials('next');
      assert.equal(creds.source, 'credentials-file');
      assert.equal(creds.token, token);
      assert.equal(creds.baseUrl, 'https://file.example');
      assert.equal(creds.expiresAt, '2026-12-25T00:00:00.000Z');
    },
  );
});

test('an empty env token is ignored rather than treated as set', async () => {
  await withCredentials({ environments: { next: block() }, env: { FORTMESA_API_TOKEN: '' } }, async () => {
    assert.equal((await resolveCredentials('next')).source, 'credentials-file');
  });
});

test('a scopeMap travels on both branches', async () => {
  const scopeMap = { acme: '615dff30842031004abc6912' };
  await withCredentials({ environments: { next: block({ scopeMap }) } }, async () => {
    assert.deepEqual((await resolveCredentials('next')).scopeMap, scopeMap);
    process.env.FORTMESA_API_TOKEN = tokenExpiringIn(3600);
    assert.deepEqual((await resolveCredentials('next')).scopeMap, scopeMap, 'the env branch reads it from the file');
  });
});

test('an absent scopeMap is omitted, not set to undefined', async () => {
  await withCredentials({ environments: { next: block() } }, async () => {
    assert.ok(!('scopeMap' in (await resolveCredentials('next'))));
  });
});

test('nothing configured at all is an actionable error naming the environment', async () => {
  await withCredentials({}, async () => {
    await assert.rejects(() => resolveCredentials('next'), /No credentials available for env "next"/);
  });
});

test('a file that does not cover this environment gives the same actionable error', async () => {
  await withCredentials({ environments: { latest: block() } }, async () => {
    await assert.rejects(() => resolveCredentials('next'), /No credentials available for env "next"/);
  });
});

test('a corrupt credentials file is reported as missing credentials, not as a parse crash', async () => {
  // The load is wrapped in .catch(() => undefined), so the zod/JSON failure is
  // swallowed. Pinning it because the resulting message is what the user sees.
  for (const raw of ['{ not json', '{"environments":{"next":{"fortmesa_api_token":"x"}}}', '[]']) {
    await withCredentials({ raw }, async () => {
      await assert.rejects(() => resolveCredentials('next'), /No credentials available for env "next"/, raw);
    });
  }
});

test('an expired file token is refused rather than put on the wire', async () => {
  await withCredentials({ environments: { next: block({ fortmesa_api_token: tokenExpiringIn(-60) }) } }, async () => {
    await assert.rejects(
      () => resolveCredentials('next'),
      (error) => {
        assert.match(error.message, /env "next" \(credentials\.json\) expired at/);
        return true;
      },
    );
  });
});

test('an expired env token is refused, and the message names the variable to fix', async () => {
  await withCredentials({ env: { FORTMESA_API_TOKEN: tokenExpiringIn(-60) } }, async () => {
    await assert.rejects(() => resolveCredentials('next'), /\(FORTMESA_API_TOKEN\) expired at/);
  });
});

test('a token inside the 30s margin is refused, and does not claim to be expired already', async () => {
  await withCredentials({ env: { FORTMESA_API_TOKEN: tokenExpiringIn(10) } }, async () => {
    await assert.rejects(
      () => resolveCredentials('next'),
      (error) => {
        assert.match(error.message, /expires at .* inside the 30s safety margin/);
        assert.ok(!error.message.includes('expired at'), 'a future timestamp must not be described as past');
        return true;
      },
    );
  });
});

test('a token just outside the margin is accepted', async () => {
  const token = tokenExpiringIn(45);
  await withCredentials({ env: { FORTMESA_API_TOKEN: token } }, async () => {
    assert.equal((await resolveCredentials('next')).token, token);
  });
});

test('an opaque non-JWT token passes through untouched', async () => {
  // Only what can be PROVEN dead is rejected. The paste and mint flows accept
  // opaque tokens, and guessing "expired" would break them.
  for (const token of ['fm_live_abc123', 'not.a.jwt', 'a.b.c.d']) {
    await withCredentials({ env: { FORTMESA_API_TOKEN: token } }, async () => {
      assert.equal((await resolveCredentials('next')).token, token, token);
    });
  }
});

test('the expiry message offers sign-in only where an OAuth sign-in exists', async () => {
  const expired = tokenExpiringIn(-60);
  await withCredentials({ env: { FORTMESA_API_TOKEN: expired } }, async () => {
    // next has a clientId, so there is a login command to point at.
    await assert.rejects(() => resolveCredentials('next'), /Run `fmmcp-local login next`/);
    // sandbox is token-only: telling the user to run login there is a dead end.
    await assert.rejects(() => resolveCredentials('sandbox'), /Paste a new one in Settings/);
    await assert.rejects(
      () => resolveCredentials('sandbox'),
      (error) => {
        assert.ok(!error.message.includes('login sandbox'));
        return true;
      },
    );
  });
});

test('no error message ever contains the token itself', async () => {
  const secret = tokenExpiringIn(-60);
  await withCredentials({ environments: { next: block({ fortmesa_api_token: secret }) } }, async () => {
    await assert.rejects(
      () => resolveCredentials('next'),
      (error) => {
        assert.ok(!error.message.includes(secret), 'a credential must never reach a log line');
        return true;
      },
    );
  });
});

test('allowExpired returns the dead entry, because login needs its baseUrl', async () => {
  await withCredentials({ environments: { next: block({ fortmesa_api_token: tokenExpiringIn(-60) }) } }, async () => {
    const creds = await resolveCredentials('next', { allowExpired: true });
    assert.equal(creds.baseUrl, 'https://file.example');
    assert.equal(creds.source, 'credentials-file');
  });
});

test('allowExpired works on the env branch too', async () => {
  await withCredentials({ env: { FORTMESA_API_TOKEN: tokenExpiringIn(-60) } }, async () => {
    assert.equal((await resolveCredentials('next', { allowExpired: true })).baseUrl, 'https://api-next.dev.fort.blue');
  });
});

test('allowExpired skips the refresh attempt entirely', async () => {
  const seen = [];
  await withCredentials({ environments: { next: block({ fortmesa_api_token: tokenExpiringIn(-60) }) } }, async () => {
    await resolveCredentials('next', { allowExpired: true, onRefresh: (o) => seen.push(o) });
  });
  assert.deepEqual(seen, [], 'spending a refresh token to satisfy a baseUrl read would be wasteful and racy');
});

test('onRefresh is notified even when the refresh did nothing', async () => {
  const seen = [];
  await withCredentials({ environments: { next: block() } }, async () => {
    await resolveCredentials('next', { onRefresh: (o) => seen.push(o) });
  });
  assert.deepEqual(seen, [{ reason: 'not-needed' }], 'a healthy token is not worth renewing');
});

test('a refresh is attempted BEFORE the token is judged, not after', async () => {
  // Reaching the expiry check with a usable refresh token on disk would kill a
  // session that did not need to end. The attempt reports no-refresh-token
  // here, but the ORDER is what this pins: the callback fires before the throw.
  const seen = [];
  await withCredentials({ environments: { next: block({ fortmesa_api_token: tokenExpiringIn(-60) }) } }, async () => {
    await assert.rejects(() => resolveCredentials('next', { onRefresh: (o) => seen.push(o) }));
  });
  assert.deepEqual(seen, [{ reason: 'no-refresh-token' }]);
});

test('an environment with no OAuth client never spends a stored refresh token', async () => {
  // sandbox is token-only. Attempting a refresh there would send a grant to an
  // issuer that has no client record for it.
  const seen = [];
  await withCredentials(
    {
      environments: {
        sandbox: block({ fortmesa_api_token: tokenExpiringIn(-60), fortmesa_refresh_token: 'stored-refresh' }),
      },
    },
    async () => {
      await assert.rejects(() => resolveCredentials('sandbox', { onRefresh: (o) => seen.push(o) }));
    },
  );
  assert.deepEqual(seen, [{ reason: 'no-client-id' }]);
});
