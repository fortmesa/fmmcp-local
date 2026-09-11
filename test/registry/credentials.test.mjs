// Unit tests for src/registry/credentials.ts's write path (R5 hardening,
// REVISION-PLAN.md F6): unique-per-call tmp filenames + credential files born
// 0600 rather than briefly world-readable under the default umask.
//
// Run against the BUILT output (same convention as test/registry/pkce.test.mjs
// / test/registry/projectors/codex.test.mjs):
//   yarn build && yarn node --test test/registry/credentials.test.mjs
//
// Isolation: points FMCODE_DIR at a fresh temp directory for the duration of
// the test (mirrors src/registry/config.ts's FMCODE_DIR override convention)
// and cleans it up afterwards — the real ~/.fmcode is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeToken, credentialsFilePath } from '../../dist/registry/credentials.js';

test('writeToken writes credentials.json with mode 0600 and leaves no stale .tmp file behind', async () => {
  const fmcodeDir = await mkdtemp(join(tmpdir(), 'fmmcp-credentials-test-'));
  const previous = process.env.FMCODE_DIR;
  process.env.FMCODE_DIR = fmcodeDir;

  try {
    await writeToken('sandbox', 'fake.token.value', 'https://sandbox.example.com');

    const path = credentialsFilePath();
    const fileStat = await stat(path);
    assert.equal(fileStat.mode & 0o777, 0o600);

    const entries = await readdir(fmcodeDir);
    const staleTmpFiles = entries.filter((name) => /^credentials\.json\..*\.tmp$/.test(name));
    assert.deepEqual(staleTmpFiles, []);
  } finally {
    if (previous === undefined) {
      delete process.env.FMCODE_DIR;
    } else {
      process.env.FMCODE_DIR = previous;
    }
    await rm(fmcodeDir, { recursive: true, force: true });
  }
});
