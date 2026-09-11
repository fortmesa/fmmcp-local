import { strict as assert } from 'node:assert';
import test from 'node:test';
import { scopeRowPresentation } from '../../dist/registry/scope-display.js';

// ── Why this file exists ────────────────────────────────────────────────
//
// The 2026-09-03 UX round removed the "this will unlock ALL scopes"
// confirmation modal on the stated grounds that the Scope selector's row
// icons already carry the state. That premise was FALSE at the time it was
// acted on: `tree-view.ts` built `activeScopes` as an EMPTY set whenever
// `scopeLock.mode === 'unlocked'`, so every row fell through to the same
// neutral `circle-large-outline` with no description that a
// locked-but-not-selected row uses. "All scopes are reachable" and "this is
// not the scope you locked to" were pixel-identical — and removing a
// confirmation while its replacement signal is ambiguous is strictly worse
// than keeping the confirmation.
//
// The reason that shipped unnoticed is that the decision lived inside a
// module which imports `vscode`, so no unit test could ever reach it. The
// fix is therefore structural, not just a patched branch: the row's
// PRESENTATION is decided by this pure function, and `tree-view.ts` only
// turns the returned ids into `vscode.ThemeIcon`s. That makes the collapse
// assertable, which is what the tests below do.

const ALL = ['alpha', 'beta'];

test('scopeRowPresentation: unlocked, locked-here and locked-elsewhere are three distinct states', () => {
  const unlocked = scopeRowPresentation('unlocked', [], 'alpha');
  const here = scopeRowPresentation('single', ['alpha'], 'alpha');
  const elsewhere = scopeRowPresentation('single', ['beta'], 'alpha');

  assert.equal(unlocked.state, 'unlocked');
  assert.equal(here.state, 'locked-here');
  assert.equal(elsewhere.state, 'locked-elsewhere');
});

// THE REGRESSION. This is the exact defect: two different states rendering
// the same glyph and the same (absent) description. A user cannot be asked
// to infer lock state from a signal that is identical in both cases.
test('REGRESSION: unlocked does not render identically to locked-elsewhere', () => {
  const unlocked = scopeRowPresentation('unlocked', [], 'alpha');
  const elsewhere = scopeRowPresentation('single', ['beta'], 'alpha');

  const visible = (p) => `${p.icon}|${p.iconColor ?? ''}|${p.description ?? ''}`;
  assert.notEqual(
    visible(unlocked),
    visible(elsewhere),
    'unlocked and locked-elsewhere must differ in icon, colour or description — this is the bug that made removing the unlock confirmation unsafe',
  );
});

test('REGRESSION: all three states are pairwise distinct to the eye, not just in their state name', () => {
  const visible = (p) => `${p.icon}|${p.iconColor ?? ''}|${p.description ?? ''}`;
  const rendered = [
    scopeRowPresentation('unlocked', [], 'alpha'),
    scopeRowPresentation('single', ['alpha'], 'alpha'),
    scopeRowPresentation('single', ['beta'], 'alpha'),
  ].map(visible);

  assert.equal(new Set(rendered).size, 3, `expected 3 visually distinct rows, got: ${JSON.stringify(rendered)}`);
});

test('every state carries a non-empty tooltip that names the scope', () => {
  for (const p of [
    scopeRowPresentation('unlocked', [], 'alpha'),
    scopeRowPresentation('single', ['alpha'], 'alpha'),
    scopeRowPresentation('multi', ['beta'], 'alpha'),
  ]) {
    assert.ok(p.tooltip.length > 0);
    assert.ok(p.tooltip.includes('alpha'), `tooltip should name the row's scope: ${p.tooltip}`);
  }
});

// `unlocked` means every scope is reachable. A stale, non-empty `scopes`
// array left over from a previous lock must NOT make a row look locked --
// mode is the authority, exactly as `resolveEffectiveStartup` treats it
// (config.ts: `scopeLocked = config.scopeLock.mode !== 'unlocked'`).
test('mode is the authority: a stale scopes array does not make an unlocked row look locked', () => {
  const p = scopeRowPresentation('unlocked', ['alpha'], 'alpha');
  assert.equal(p.state, 'unlocked');
  assert.deepEqual(p, scopeRowPresentation('unlocked', [], 'alpha'));
});

test('multi mode marks every member as locked-here, and non-members as locked-elsewhere', () => {
  assert.equal(scopeRowPresentation('multi', ALL, 'alpha').state, 'locked-here');
  assert.equal(scopeRowPresentation('multi', ALL, 'beta').state, 'locked-here');
  assert.equal(scopeRowPresentation('multi', ALL, 'gamma').state, 'locked-elsewhere');
});

// A locked mode with NO scopes denies everything (ScopeLock's documented
// fail-closed contract). No row may present as locked-here in that state.
test('fail-closed: a locked mode with an empty scope set marks every row locked-elsewhere', () => {
  assert.equal(scopeRowPresentation('single', [], 'alpha').state, 'locked-elsewhere');
  assert.equal(scopeRowPresentation('multi', [], 'alpha').state, 'locked-elsewhere');
});
