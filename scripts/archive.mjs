/**
 * Zip writing and zip/tgz reading in plain Node, with no dependency and no
 * external tool.
 *
 * Three constraints ruled out every alternative. CI runs `yarn install
 * --immutable` fully offline against a committed cache (INV-HERMETIC), so a
 * new dependency means committing its zips. Yarn PnP refuses to resolve a
 * package that package.json does not declare, so borrowing vsce's transitive
 * `yazl` is not possible. And shelling out to `zip`/`unzip` bets on tools the
 * `node:24` image is not guaranteed to carry, which for the release verifier
 * is the worst option of the three: a missing tool there means a build nobody
 * actually checked.
 *
 * `node:zlib` supplies crc32 and raw deflate/inflate, which is the whole of
 * what the ZIP format needs on top of byte layout.
 *
 * Scope is deliberately narrow: what this repo's release artifacts use.
 * Deflate and store, no encryption, no zip64, no symlinks, ASCII entry names.
 * Anything outside that is rejected rather than written wrong.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LIMIT = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * A fixed DOS timestamp for every entry: 1980-01-01 00:00:00, the earliest
 * the format can express.
 *
 * Real mtimes would make two builds of identical inputs produce different
 * bytes, which costs reproducibility and gains nothing. No consumer of a
 * `.mcpb` reads these.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Build a zip. `entries` is `[{ name, data }]` with POSIX-separated names.
 *
 * Each entry is stored if deflate fails to make it smaller, which is both
 * smaller on average and what every other writer does.
 */
export function writeZip(entries) {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`zip: ${String(entries.length)} entries exceeds the ${String(MAX_ENTRIES)} this writer supports`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    if (body.length > ZIP64_LIMIT) {
      throw new Error(`zip: ${name} is larger than 4GB, which needs zip64`);
    }

    // ASCII only, enforced rather than assumed. Every path this repo puts in
    // an archive is ASCII, and ASCII is byte-identical under CP437 and UTF-8,
    // so no encoding flag is needed and no reader can disagree about a name.
    // A non-ASCII name would need general-purpose bit 11 set, which Info-ZIP
    // 6.00 ignores by default anyway; rejecting it is honest, silently
    // mis-encoding it is not.
    if (!/^[\x20-\x7e]+$/.test(name)) {
      throw new Error(`zip: entry name "${name}" is not printable ASCII; this writer stores ASCII names only`);
    }

    const nameBytes = Buffer.from(name, 'ascii');
    const deflated = deflateRawSync(body);
    const stored = deflated.length >= body.length;
    const payload = stored ? body : deflated;
    const method = stored ? 0 : 8;
    const sum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // `>>> 0` is load-bearing: `<<` is a SIGNED 32-bit op in JS, and
    // 0o100644 << 16 overflows past 2^31 to a negative number that
    // writeUInt32LE rejects outright.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBytes, eocd]);
}

/** Read a zip into `[{ name, data }]`, walking the central directory. */
export function readZip(buffer) {
  // The EOCD sits at the end, after a comment of unknown length, so scan back
  // for its signature rather than assuming it is the last 22 bytes.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip: no end-of-central-directory record; not a zip file');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`zip: corrupt central directory at entry ${String(i)}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf-8', cursor + 46, cursor + 46 + nameLength);

    // The local header's own name/extra lengths are authoritative for where
    // the payload starts; they can differ from the central directory's.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    out.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return out;
}

/**
 * Read a gzipped tar into `[{ name, data }]`, regular files only.
 *
 * Enough of the format for a `yarn pack` tarball: 512-byte headers, ustar
 * long-name prefixes, and the GNU/PAX extended-header records that npm emits
 * for long paths.
 */
export function readTgz(buffer) {
  const tar = gunzipSync(buffer);
  const out = [];
  let cursor = 0;
  let pendingLongName;

  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) break;

    const readField = (start, length) =>
      header
        .toString('utf-8', start, start + length)
        .replace(/\0.*$/, '')
        .trim();

    const rawName = readField(0, 100);
    const prefix = readField(345, 155);
    const size = parseInt(readField(124, 12) || '0', 8);
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(cursor + 512, cursor + 512 + size);
    cursor += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU long name: the next header's name comes from this record.
      pendingLongName = body.toString('utf-8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      // PAX extended header: "<len> path=<value>\n".
      const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(body.toString('utf-8'));
      if (match) pendingLongName = match[1];
      continue;
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = undefined;

    if (type === '0' || type === '\0') out.push({ name, data: Buffer.from(body) });
  }

  return out;
}

/** Stable digest of an archive's contents, for asserting reproducible builds. */
export function contentDigest(entries) {
  const hash = createHash('sha256');
  for (const { name, data } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(name);
    hash.update(data);
  }
  return hash.digest('hex');
}
