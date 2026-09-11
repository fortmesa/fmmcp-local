// Unit tests for src/shared/compress-upload.ts.
//
// Run against the BUILT output, same convention as the other tests here:
//   yarn build && yarn node --test test/shared/compress-upload.test.mjs
//
// The upload path only pays off if three things hold: a compressible body
// really does shrink, an incompressible one is not made bigger or slower, and
// the multipart envelope survives the round trip so busboy can still parse it
// after fmweb-be inflates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

const { buildUploadBody, worthCompressing, MIN_COMPRESS_BYTES, PROBE_THRESHOLD_BYTES } =
  await import('../../dist/shared/compress-upload.js');

function form(bytes, name = 'probe.csv') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), name);
  return fd;
}

test('a compressible CSV goes on the wire gzipped and much smaller', async () => {
  const csv = Buffer.from('asset,owner,status\nweb-01,ops,active\n'.repeat(50_000));
  const upload = await buildUploadBody(form(csv));

  assert.equal(upload.compressed, true);
  assert.equal(upload.headers['Content-Encoding'], 'gzip');
  assert.match(upload.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.ok(upload.body.length < csv.length / 10, `expected big savings, got ${upload.body.length} from ${csv.length}`);
});

test('the gzipped body inflates back to the exact multipart envelope', async () => {
  const csv = Buffer.from('a,b,c\n1,2,3\n'.repeat(20_000));
  const upload = await buildUploadBody(form(csv));

  const inflated = gunzipSync(upload.body);
  assert.equal(inflated.length, upload.rawBytes);
  // The file's bytes have to still be in there verbatim for busboy to find them.
  assert.ok(inflated.includes(csv.subarray(0, 512)));
  assert.match(inflated.subarray(0, 200).toString('latin1'), /Content-Disposition: form-data; name="file"/);
});

test('incompressible content is sent as-is rather than padded', async () => {
  // Random bytes: gzip cannot beat them and would add framing.
  const random = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < random.length; i += 4) random.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);

  const upload = await buildUploadBody(form(random, 'probe.bin'));

  assert.equal(upload.compressed, false);
  assert.equal(upload.headers['Content-Encoding'], undefined);
  assert.equal(upload.body.length, upload.rawBytes);
});

test('a tiny body skips compression, where the header costs more than it saves', async () => {
  const upload = await buildUploadBody(form(Buffer.from('id\n1\n')));

  assert.equal(upload.compressed, false);
  assert.ok(upload.rawBytes < MIN_COMPRESS_BYTES);
});

test('worthCompressing probes large bodies instead of trusting size alone', () => {
  assert.equal(worthCompressing(Buffer.alloc(MIN_COMPRESS_BYTES - 1)), false);
  // Compressible and over the probe threshold.
  assert.equal(worthCompressing(Buffer.alloc(PROBE_THRESHOLD_BYTES + 1024)), true);
  // Compressible but under it, so no probe is needed.
  assert.equal(worthCompressing(Buffer.from('x'.repeat(MIN_COMPRESS_BYTES + 1))), true);
});
