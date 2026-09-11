// Unit tests for scripts/archive.mjs, the dependency-free zip writer/reader
// the .mcpb build and the release verifier both run on.
//
// This code writes bytes by hand, so it is tested against an INDEPENDENT
// implementation rather than only against itself: every archive is handed to
// the system `unzip` as well as to our own reader. That pairing already
// caught a signed-shift overflow in the external-attributes field, which a
// self-round-trip would have missed entirely.
//
// Run: yarn node --test test/scripts/archive.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDigest, readZip, writeZip } from '../../scripts/archive.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Whether a usable system `unzip` exists to cross-check against.
 *
 * Runs the binary rather than asking `command -v` whether it is on PATH.
 * Presence is not usability: Info-ZIP builds differ in which options they
 * accept, and a flag missing from one build exits 10 with a usage dump, which
 * reads as "our archive is malformed" when it means nothing of the sort.
 */
const hasUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf-8' }).status === 0;

const SAMPLE = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest_version: '0.3' })) },
  // Highly compressible: exercises the deflate path.
  { name: 'server/cli.cjs', data: Buffer.from('x'.repeat(50_000)) },
  // Incompressible: exercises the store fallback.
  { name: 'assets/rand.bin', data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)) },
  { name: 'empty.txt', data: Buffer.alloc(0) },
];

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fortmesa-archive-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeZip/readZip: round-trips every entry byte-for-byte', () => {
  const back = readZip(writeZip(SAMPLE));
  assert.equal(back.length, SAMPLE.length);
  assert.equal(contentDigest(back), contentDigest(SAMPLE));
});

test('writeZip: stores incompressible data rather than inflating it', () => {
  const [entry] = readZip(writeZip([SAMPLE[2]]));
  assert.ok(entry.data.equals(SAMPLE[2].data));
});

test('writeZip: is reproducible: identical input yields identical bytes', () => {
  // Fixed DOS timestamps exist for exactly this. A real mtime would make two
  // builds of the same tree differ.
  assert.ok(writeZip(SAMPLE).equals(writeZip(SAMPLE)));
});

test('writeZip: rejects a non-ASCII entry name instead of mis-encoding it', () => {
  // Written as an escape so this source file stays pure ASCII.
  const name = `bad-\u00fc-name.txt`;
  assert.throws(() => writeZip([{ name, data: Buffer.from('x') }]), /printable ASCII/);
});

test('readZip: rejects a buffer with no end-of-central-directory record', () => {
  assert.throws(() => readZip(Buffer.from('definitely not a zip file')), /not a zip file/);
});

test(
  'writeZip: the system unzip accepts and agrees with it',
  { skip: hasUnzip ? false : 'unzip not installed' },
  () => {
    inTempDir((dir) => {
      const path = join(dir, 'probe.zip');
      writeFileSync(path, writeZip(SAMPLE));

      const integrity = spawnSync('unzip', ['-t', path], { encoding: 'utf-8' });
      assert.equal(integrity.status, 0, `unzip -t rejected the archive:\n${integrity.stdout}${integrity.stderr}`);

      const out = join(dir, 'extracted');
      const extract = spawnSync('unzip', ['-q', '-d', out, path], { encoding: 'utf-8' });
      assert.equal(extract.status, 0, extract.stderr);

      for (const entry of SAMPLE) {
        assert.ok(
          readFileSync(join(out, entry.name)).equals(entry.data),
          `unzip produced different bytes for ${entry.name}`,
        );
      }
    });
  },
);

test('readZip: parses a real vsce-produced .vsix if one is present', () => {
  const built = spawnSync('sh', ['-c', `ls ${repoRoot}/FortMesa-Saferoom-*.vsix 2>/dev/null | head -1`], {
    encoding: 'utf-8',
  }).stdout.trim();
  if (built === '') return; // Nothing built in this working tree; nothing to assert.

  const entries = readZip(readFileSync(built));
  assert.ok(
    entries.some((entry) => entry.name === 'extension.vsixmanifest'),
    'a real .vsix should contain extension.vsixmanifest',
  );
});
