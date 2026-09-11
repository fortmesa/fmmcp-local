// Settings sections: order and default-open state (PO, 2026-09-08).
//
// This is a decision that ships wrong silently if it lives in a webview string
// literal — nothing in this repo's rig can load a `vscode`-importing module —
// so it lives in `registry/settings-sections.ts` and is asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTIONS_KEY,
  resolveSettingsSections,
  withSectionOpen,
  isSettingsSectionId,
} from '../../dist/registry/settings-sections.js';

test('the PO order, exactly: Agents, Tools, Data region, Identity, Scope', () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.id),
    ['agents', 'tools', 'dataRegion', 'identity', 'scope'],
  );
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.title),
    ['Agents', 'Tools', 'Data region', 'Identity', 'Scope'],
  );
});

test('only Agents and Tools are open by default — the two you can actually operate here', () => {
  const open = SETTINGS_SECTIONS.filter((section) => section.defaultOpen).map((section) => section.id);
  assert.deepEqual(open, ['agents', 'tools']);
});

test('a machine with no memory gets the defaults', () => {
  const sections = resolveSettingsSections(undefined);
  assert.deepEqual(
    sections.map((section) => [section.id, section.open]),
    [
      ['agents', true],
      ['tools', true],
      ['dataRegion', false],
      ['identity', false],
      ['scope', false],
    ],
  );
});

test('stored state wins, per section, in both directions', () => {
  const sections = resolveSettingsSections({ agents: false, scope: true });
  const byId = Object.fromEntries(sections.map((section) => [section.id, section.open]));
  assert.equal(byId.agents, false, 'a closed default-open section stays closed');
  assert.equal(byId.scope, true, 'an opened default-closed section stays open');
  assert.equal(byId.tools, true, 'sections with no memory keep their default');
});

test('junk memory falls back to the DEFAULT, never to "closed"', () => {
  // A section added in a later version, or memory written by an older one,
  // must still open the way its author intended.
  for (const junk of [null, 'nonsense', 42, [], { agents: 'yes', tools: 1 }, { unknownSection: true }]) {
    const byId = Object.fromEntries(resolveSettingsSections(junk).map((s) => [s.id, s.open]));
    assert.equal(byId.agents, true, `agents collapsed by junk: ${JSON.stringify(junk)}`);
    assert.equal(byId.tools, true);
    assert.equal(byId.identity, false);
  }
});

test('toggling writes back every known id and no unknown ones, so old keys do not accumulate', () => {
  const next = withSectionOpen(resolveSettingsSections({ legacySection: true }), 'scope', true);
  assert.deepEqual(Object.keys(next).sort(), ['agents', 'dataRegion', 'identity', 'scope', 'tools']);
  assert.equal(next.scope, true);
  assert.equal(next.agents, true, 'toggling one section must not disturb the others');
});

test('the inbound message id is guarded', () => {
  assert.equal(isSettingsSectionId('agents'), true);
  for (const bad of ['Agents', 'data-region', '', null, undefined, 0, {}]) {
    assert.equal(isSettingsSectionId(bad), false, `${String(bad)} must not pass the guard`);
  }
});

test('the globalState key is namespaced', () => {
  assert.match(SETTINGS_SECTIONS_KEY, /^fortmesa\./);
});
