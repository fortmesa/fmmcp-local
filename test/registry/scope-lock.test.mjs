// Unit tests for src/shared/scope-lock.ts and the lockedness plumbing in
// src/registry/config.ts's resolveEffectiveStartup.
//
// Run against the BUILT output, same convention as the sibling registry tests:
//   yarn build && yarn node --test test/registry/scope-lock.test.mjs
//
// These cover three defects reported against `feat/saferoom-vsix`:
//   1. `mode: single|multi` with `scopes: []` failed OPEN (every scope permitted).
//   2. (proxy-side, covered in proxy-reload-quarantine.test.mjs)
//   3. The lockout message asserted "Authorized scopeIds: [...]" while listing
//      the LOCKED-TO ids, telling a caller it lacked authorisation it had.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeLock, resolveScopeLock } from '../../dist/shared/scope-lock.js';
import { resolveEffectiveStartup } from '../../dist/registry/config.js';

/** Run `fn`, assert it threw, and hand back the Error so the message can be inspected. */
function captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw, but it returned normally');
}

const LOCKED = [{ scopeId: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'acme-prod' }];
const KNOWN = { 'acme-prod': 'aaaaaaaaaaaaaaaaaaaaaaaa', fmlab1: 'bbbbbbbbbbbbbbbbbbbbbbbb' };

// ── Defect 1: fail-closed ────────────────────────────────────────────────────

test('a lock configured with no scopes denies every scope (fail closed)', () => {
  const lock = ScopeLock.lockedTo([], { env: 'prod' });
  assert.equal(lock.isLocked, true);
  assert.throws(() => {
    lock.assertAuthorized('bbbbbbbbbbbbbbbbbbbbbbbb');
    // Vocabulary changed 2026-09-08 (Accessible/Inaccessible); the property
    // under test is unchanged — an empty lock must deny, and must say so.
  }, /no scope is accessible/i);
});

test('ScopeLock.unlocked() still permits every scope', () => {
  const lock = ScopeLock.unlocked();
  assert.equal(lock.isLocked, false);
  assert.doesNotThrow(() => {
    lock.assertAuthorized('bbbbbbbbbbbbbbbbbbbbbbbb');
  });
});

test('resolveEffectiveStartup reports scopeLocked=true for mode single with no scopes', () => {
  const config = {
    activeEnv: 'prod',
    environments: { prod: { gateway: 'https://example.invalid/mcp' } },
    scopeLock: { mode: 'single', scopes: [] },
    ideSync: {},
    disabledTools: [],
    logLevel: 'info',
  };
  const effective = resolveEffectiveStartup({}, config, () => {});
  assert.deepEqual(effective.scopeLockNames, []);
  assert.equal(effective.scopeLocked, true, 'lockedness must survive an empty scopes array');
});

test('resolveEffectiveStartup reports scopeLocked=false only for mode unlocked', () => {
  const config = {
    activeEnv: 'prod',
    environments: { prod: { gateway: 'https://example.invalid/mcp' } },
    scopeLock: { mode: 'unlocked', scopes: [] },
    ideSync: {},
    disabledTools: [],
    logLevel: 'info',
  };
  assert.equal(resolveEffectiveStartup({}, config, () => {}).scopeLocked, false);
});

// ── Defect 3: the message must not assert the opposite of the truth ──────────

test('a scope the identity DOES hold is reported as a local restriction, not an authorisation failure', () => {
  const lock = ScopeLock.lockedTo(LOCKED, { env: 'prod', knownScopes: KNOWN });
  const msg = String(captureThrow(() => lock.assertAuthorized('bbbbbbbbbbbbbbbbbbbbbbbb')).message);
  assert.match(msg, /inaccessible/i, 'must say the scope is inaccessible here');
  assert.match(msg, /local/i, 'must name the LOCAL configuration as the cause');
  assert.match(msg, /not your account permissions/i, 'must disclaim the authorisation reading');
  assert.match(msg, /fmlab1/, 'must name the scope the caller asked for');
  assert.match(msg, /acme-prod/, 'must name what this instance does make accessible');
  assert.doesNotMatch(msg, /Authorized scopeIds/, 'the misleading phrase must be gone');
});

test('a scope absent from the known list is reported as unknown-and-possibly-stale, never as denied', () => {
  const lock = ScopeLock.lockedTo(LOCKED, { env: 'prod', knownScopes: KNOWN });
  const msg = String(captureThrow(() => lock.assertAuthorized('cccccccccccccccccccccccc')).message);
  assert.match(msg, /not in this identity's known scope list/i);
  assert.match(msg, /stale/i, 'must not assert non-entitlement from a cache miss');
  assert.match(msg, /refresh/i, 'must name the action that would settle it');
  assert.doesNotMatch(msg, /Authorized scopeIds/);
});

test('an authorized scope passes', () => {
  const lock = ScopeLock.lockedTo(LOCKED, { env: 'prod', knownScopes: KNOWN });
  assert.doesNotThrow(() => {
    lock.assertAuthorized('aaaaaaaaaaaaaaaaaaaaaaaa');
  });
});

// ── Regression guard: resolveScopeLock's own behaviour is unchanged ──────────

test('resolveScopeLock still resolves case-insensitively and still fails fast', () => {
  assert.deepEqual(resolveScopeLock(['ACME-Prod'], KNOWN, 'prod'), [
    { scopeId: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'acme-prod' },
  ]);
  assert.deepEqual(resolveScopeLock([], KNOWN, 'prod'), []);
  assert.throws(() => resolveScopeLock(['nope'], KNOWN, 'prod'), /not found in scopeMap/);
  assert.throws(() => resolveScopeLock(['x'], undefined, 'prod'), /requires a "scopeMap"/);
});

// -- resolveScopeLock: name resolution, and what it refuses to guess -------

test('resolveScopeLock: no names asks for no lock at all', () => {
  assert.deepEqual(resolveScopeLock([], undefined, 'next'), []);
});

test('resolveScopeLock: refuses to guess when the scopeMap is absent', () => {
  // Returning [] here would build a locked-but-empty lock, which denies
  // everything, with nothing to tell the user why.
  assert.throws(() => resolveScopeLock(['acme-prod'], undefined, 'next'), /requires a "scopeMap"/);
  assert.throws(() => resolveScopeLock(['acme-prod'], {}, 'next'), /requires a "scopeMap"/);
});

test('resolveScopeLock: an unknown name is reported, never quietly dropped', () => {
  // Dropping it would lock the user to a SUBSET of what they asked for
  // without saying so.
  assert.throws(() => resolveScopeLock(['acme-prod', 'nope'], KNOWN, 'next'), /nope/);
});

test('resolveScopeLock: several names resolve together, in the order given', () => {
  assert.deepEqual(resolveScopeLock(['fmlab1', 'acme-prod'], KNOWN, 'next'), [
    { scopeId: KNOWN.fmlab1, name: 'fmlab1' },
    { scopeId: KNOWN['acme-prod'], name: 'acme-prod' },
  ]);
});

test("resolveScopeLock: a resolved name keeps the scopeMap spelling, not the caller's casing", () => {
  assert.deepEqual(resolveScopeLock(['ACME-PROD'], KNOWN, 'next'), [
    { scopeId: KNOWN['acme-prod'], name: 'acme-prod' },
  ]);
});

test('resolveScopeLock: the environment name reaches the error, so the user knows which file section to fix', () => {
  assert.throws(() => resolveScopeLock(['acme-prod'], undefined, 'latest'), /"latest"/);
});

test('authorizedIds exposes exactly the locked set, for filtering a scope list', () => {
  assert.deepEqual([...ScopeLock.lockedTo(LOCKED).authorizedIds], [LOCKED[0].scopeId]);
  assert.deepEqual([...ScopeLock.unlocked().authorizedIds], [], 'unlocked constrains nothing, so it lists nothing');
});
