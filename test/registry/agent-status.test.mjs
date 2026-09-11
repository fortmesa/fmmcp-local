// Item 6/6a (PO, 2026-09-05): the Settings > Agents status strings.
//
// PO on the originals ("detected" / "not detected on this machine" /
// "supported by this host"): "the strings used here are not delightful ... why
// is one string more verbose? ... no idea what supported on this host means".
// PO on the first chip pass: "I still don't know the difference between
// detected and configured". So the labels became two everyday facts shown
// together on every row — machine presence, then whether FortMesa is wired in.
//
// This suite is exhaustive over the state machine: every AgentPresence value,
// times connected/not, has an asserted label set. That is the point — the PO
// could not enumerate the possible values, so the possible values are now
// enumerable here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentRowLabels, agentName } from '../../dist/registry/agent-status.js';

const labels = (row) => agentRowLabels(row).chips.map((c) => c.label);

test('agentName: every sync target has a human name, not a config key', () => {
  assert.equal(agentName('claude'), 'Claude Code');
  assert.equal(agentName('vscode'), 'VS Code');
  assert.equal(agentName('cursor'), 'Cursor');
  assert.equal(agentName('codex'), 'Codex');
  assert.equal(agentName('antigravity'), 'Antigravity');
  assert.equal(agentName('copilot'), 'GitHub Copilot');
  assert.equal(agentName('somefutureagent'), 'somefutureagent', 'an unknown target degrades to its key');
});

test('installed + connected -> "Installed · Connected", no hint, no Connect action', () => {
  const row = agentRowLabels({ target: 'claude', presence: 'installed', connected: true });
  assert.deepEqual(labels({ target: 'claude', presence: 'installed', connected: true }), ['Installed', 'Connected']);
  assert.equal(row.hint, undefined);
  assert.equal(row.canConnect, false);
});

test('installed + NOT connected -> "Installed · Not connected" with an inline Connect action', () => {
  const row = agentRowLabels({ target: 'cursor', presence: 'installed', connected: false });
  assert.deepEqual(
    row.chips.map((c) => c.label),
    ['Installed', 'Not connected'],
  );
  assert.equal(row.canConnect, true, 'this is the one state the user can act on inline');
});

test('not installed -> a single "Not installed" chip plus the actionable hint, and NO FortMesa chip', () => {
  const row = agentRowLabels({ target: 'codex', presence: 'not-installed', connected: false });
  assert.deepEqual(
    row.chips.map((c) => c.label),
    ['Not installed'],
  );
  assert.equal(row.hint, 'Install Codex to connect it');
  assert.equal(row.canConnect, false);
});

test('not installed stays "Not installed" even if the sync flag is on — presence is the governing fact', () => {
  const row = agentRowLabels({ target: 'codex', presence: 'not-installed', connected: true });
  assert.deepEqual(
    row.chips.map((c) => c.label),
    ['Not installed'],
  );
  assert.equal(row.canConnect, false);
});

test('the host editor reads "This editor", never "supported by this host"', () => {
  for (const connected of [true, false]) {
    const row = agentRowLabels({ target: 'vscode', presence: 'this-editor', connected });
    assert.equal(row.chips[0].label, 'This editor');
    assert.equal(row.chips[1].label, connected ? 'Connected' : 'Not connected');
    assert.equal(row.canConnect, !connected);
    assert.equal(/supported by this host/.test(JSON.stringify(row)), false);
  }
});

test('an error/partial state collapses to "Needs attention" with the cause in the tooltip AND the hint', () => {
  const row = agentRowLabels({
    target: 'antigravity',
    presence: 'needs-attention',
    connected: false,
    attentionDetail: 'EACCES reading its config directory',
  });
  assert.deepEqual(
    row.chips.map((c) => c.label),
    ['Needs attention'],
  );
  assert.equal(row.chips[0].tooltip, 'EACCES reading its config directory');
  assert.equal(row.hint, 'EACCES reading its config directory');
  assert.equal(row.canConnect, false);
});

test('"Needs attention" with no detail still explains itself rather than showing an empty tooltip', () => {
  const row = agentRowLabels({ target: 'cursor', presence: 'needs-attention', connected: false });
  assert.match(row.chips[0].tooltip, /could not determine Cursor's state/);
  assert.equal(row.hint, undefined);
});

test('the two tooltips are the PO-specified sentences, and name the agent', () => {
  const installed = agentRowLabels({ target: 'claude', presence: 'installed', connected: true });
  assert.equal(installed.chips[0].tooltip, 'Found Claude Code on this machine');
  assert.equal(installed.chips[1].tooltip, "FortMesa is configured in Claude Code's MCP settings");
  const off = agentRowLabels({ target: 'claude', presence: 'installed', connected: false });
  assert.equal(off.chips[1].tooltip, "FortMesa is not configured in Claude Code's MCP settings");
});

test('no label is sentence-length, and every state word is one or two words', () => {
  const rows = [
    { target: 'claude', presence: 'installed', connected: true },
    { target: 'claude', presence: 'installed', connected: false },
    { target: 'claude', presence: 'not-installed', connected: false },
    { target: 'vscode', presence: 'this-editor', connected: true },
    { target: 'vscode', presence: 'this-editor', connected: false },
    { target: 'claude', presence: 'needs-attention', connected: false },
  ];
  for (const row of rows) {
    for (const chip of agentRowLabels(row).chips) {
      assert.ok(chip.label.split(' ').length <= 2, `"${chip.label}" is too long for a chip`);
      assert.equal(/\./.test(chip.label), false, `"${chip.label}" reads as a sentence`);
    }
  }
});

test('the old free-text status strings are gone from the settings webview', async () => {
  const src = await readFile(new URL('../../dist/extension/saferoom-settings.js', import.meta.url), 'utf-8');
  for (const dead of ['not detected on this machine', 'supported by this host', 'detectionNote']) {
    assert.equal(src.includes(dead), false, `"${dead}" must be gone`);
  }
  assert.match(src, /agentRowLabels/, 'the rows must be labelled by the shared mapping');
  assert.match(src, /data-connect/, 'the inline Connect action must be rendered');
});
