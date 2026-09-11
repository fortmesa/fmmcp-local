// Regression tests for the security-delta findings F-1, F-4 and F-5
// (source: RESULT-vsix-security-delta.md, 2026-09-04).
//
// Run against the BUILT output where the subject is compiled code:
//   yarn build && yarn node --test test/scripts/security-delta.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { parsePastedCode } from '../../dist/registry/oauth-flow.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── F-1 — HTML attribute injection in the webview row builders ──────────────
//
// The webview client scripts live inside template strings, so the subject is the
// emitted text. Every `id="`/`for="` attribute interpolation must be escaped —
// `scope-select-panel.ts:145-147` already does; `saferoom-settings.ts:427-431`
// did not, and `tool.name` there is GATEWAY-SUPPLIED.

const WEBVIEWS = [
  'src/extension/saferoom-settings.ts',
  'src/extension/scope-select-panel.ts',
  'src/extension/identity-view.ts',
  // Added by SIGNIN-2: the dedicated sign-in page is a fourth webview, and it
  // renders an email address and an authorization server's error message.
  'src/extension/sign-in-page.ts',
];

test('F-1: every id=/for= attribute interpolation in a webview is escaped', async () => {
  for (const rel of WEBVIEWS) {
    const src = await readFile(join(repoRoot, rel), 'utf-8');
    // Match:  id="' + <expr>     /  for="' + <expr>
    const pattern = /(?:\bid|\bfor)="'\s*\+\s*(?!escapeHtml\()([A-Za-z_$][\w$.]*)/g;
    for (const m of src.matchAll(pattern)) {
      assert.fail(`${rel}: attribute value "${m[1]}" is interpolated without escapeHtml() — ${m[0]}`);
    }
  }
});

test('F-1: the tool and agent rows still escape their id, and still build an id', async () => {
  const src = await readFile(join(repoRoot, 'src/extension/saferoom-settings.ts'), 'utf-8');
  assert.match(src, /const id = 'tool-' \+ tool\.name;/, 'the tool row must still derive an id');
  assert.match(src, /const id = 'agent-' \+ agent\.target;/, 'the agent row must still derive an id');
  const escapedAttrs = [...src.matchAll(/(?:\bid|\bfor)="'\s*\+\s*escapeHtml\(id\)/g)];
  assert.ok(
    escapedAttrs.length >= 4,
    `expected >=4 escaped id attributes in the two row builders, saw ${escapedAttrs.length}`,
  );
});

// ── F-2 — CSP nonces must come from a CSPRNG ────────────────────────────────

test('F-2: no webview builds its CSP nonce from Math.random()', async () => {
  for (const rel of WEBVIEWS) {
    const src = await readFile(join(repoRoot, rel), 'utf-8');
    assert.equal(/Math\.random/.test(src), false, `${rel}: CSP nonce must not use Math.random()`);
    assert.match(src, /randomBytes\(16\)\.toString\('base64'\)/, `${rel}: nonce must come from node:crypto`);
  }
});

// ── F-4 — the paste-code OAuth path must verify `state` ─────────────────────

test('F-4: parsePastedCode returns the state from a full redirect URL', () => {
  const parsed = parsePastedCode('http://127.0.0.1:43117/callback?code=the-auth-code&state=abc123');
  assert.deepEqual(parsed, { code: 'the-auth-code', state: 'abc123' });
});

test('F-4 (round 2): no sign-in question is asked through an input box or quick pick', async () => {
  // PO direction: sign-in UX lives on the dedicated sign-in page only. As of
  // SIGNIN-2 that includes the LAST holdout — the API base URL for an
  // environment Saferoom does not ship, which used to be an input box in
  // `login-command.ts` and is now a field on the page (S0).
  const session = await readFile(join(repoRoot, 'src/extension/sign-in-session.ts'), 'utf-8');
  assert.equal(
    /vscode\.window\.show(InputBox|QuickPick)\(/.test(session),
    false,
    'the transport must have no UI of its own',
  );
  const command = await readFile(join(repoRoot, 'src/extension/login-command.ts'), 'utf-8');
  assert.equal(/showQuickPick/.test(command), false);
  assert.equal(
    (command.match(/vscode\.window\.showInputBox\(/g) ?? []).length,
    0,
    'no input box may remain on the sign-in path',
  );
  const page = await readFile(join(repoRoot, 'src/extension/sign-in-page.ts'), 'utf-8');
  assert.equal(/vscode\.window\.show(InputBox|QuickPick)\(/.test(page), false);
  assert.match(page, /apiBaseInput/, 'the API base must be a field on the page instead');
});

// ── F-5 — the prod-strip verifier must not self-certify ─────────────────────

test('F-5: verify-prod-strip FAILS when FORTMESA_PROD_ONLY is unset', async () => {
  const env = { ...process.env };
  delete env.FORTMESA_PROD_ONLY;
  let err;
  try {
    await execFileAsync(process.execPath, [join(repoRoot, 'scripts/verify-prod-strip.mjs')], { env, cwd: repoRoot });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'an unset FORTMESA_PROD_ONLY must be a non-zero exit, not a printed pass');
  assert.notEqual(err.code, 0);
  assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /FORTMESA_PROD_ONLY/, 'the failure must name the variable');
});

test('F-5: verify-prod-strip accepts an EXPLICIT false as an acknowledged dev build, loudly', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [join(repoRoot, 'scripts/verify-prod-strip.mjs')], {
    env: { ...process.env, FORTMESA_PROD_ONLY: 'false' },
    cwd: repoRoot,
  });
  const out = `${stdout}${stderr}`;
  assert.match(out, /NOT a release artifact|dev build/i, 'an explicit dev build must be labelled unmistakably');
});

test('F-5: package:ext declares the flag explicitly rather than leaving it unset', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8'));
  assert.match(
    pkg.scripts['package:ext'],
    /FORTMESA_PROD_ONLY=/,
    'package:ext must state which kind of build it is; silence is what let it self-certify',
  );
  assert.match(pkg.scripts['package:ext:prod'], /package-prod\.mjs/, 'the release path is unchanged');
});

// ── F-6 — the API base must be https, except on loopback ────────────────────

test('F-6: requireSecureApiBase accepts https and loopback http, rejects remote http', async () => {
  const { requireSecureApiBase } = await import('../../dist/registry/environments.js');
  assert.equal(requireSecureApiBase('https://api.fortmesa.com'), 'https://api.fortmesa.com');
  assert.equal(requireSecureApiBase('http://localhost:3010'), 'http://localhost:3010');
  assert.equal(requireSecureApiBase('http://127.0.0.1:3010'), 'http://127.0.0.1:3010');
  assert.throws(() => requireSecureApiBase('http://api.example.com'), /https/i);
  assert.throws(() => requireSecureApiBase('not a url'), /URL/i);
});
