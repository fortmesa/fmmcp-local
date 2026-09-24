import { strict as assert } from 'node:assert';
import test from 'node:test';
import { nextScopeLockOnSelectorClick } from '../../dist/registry/scope-display.js';

// MFDV-527: today a checked scope never unchecks on click, because the old
// `handleSelectScope` always wrote `{mode:'single', scopes:[clicked]}`
// regardless of the current lock. These tests exercise the pure reducer that
// replaced that unconditional overwrite.

test('deselects an accessible scope when more than one scope is currently selected', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'multi', scopes: ['alpha', 'beta'] }, 'alpha');
  assert.deepEqual(next, { mode: 'single', scopes: ['beta'] });
});

test('deselecting down to two scopes stays multi', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'multi', scopes: ['alpha', 'beta', 'gamma'] }, 'beta');
  assert.equal(next.mode, 'multi');
  assert.deepEqual(next.scopes.slice().sort(), ['alpha', 'gamma']);
});

test('never deselects the last accessible scope', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'single', scopes: ['alpha'] }, 'alpha');
  assert.deepEqual(next, { mode: 'single', scopes: ['alpha'] });
});

test('clicking an inaccessible scope switches to it: selects the new, deselects the old', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'multi', scopes: ['alpha', 'beta'] }, 'gamma');
  assert.deepEqual(next, { mode: 'single', scopes: ['gamma'] });
});

test('clicking any scope while unlocked switches to it exclusively (nothing is "currently selected" in unlocked mode)', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'unlocked', scopes: [] }, 'alpha');
  assert.deepEqual(next, { mode: 'single', scopes: ['alpha'] });
});

test('a stale non-empty scopes array under mode:unlocked is still treated as unlocked (mode is authority, not scopes.length)', () => {
  const next = nextScopeLockOnSelectorClick({ mode: 'unlocked', scopes: ['alpha'] }, 'alpha');
  assert.deepEqual(next, { mode: 'single', scopes: ['alpha'] });
});
