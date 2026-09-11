import { gzipSync } from 'node:zlib';
import { constants } from 'node:zlib';

/**
 * Compress an upload before it goes on the wire.
 *
 * A CSV export is the case that matters: tens of megabytes that gzip to a
 * fraction of that, where the transfer, not the server, is what makes the
 * upload slow. fmweb-be inflates the body before multer sees it, so the file
 * it stores is identical either way.
 *
 * gzip and only gzip. A browser can produce gzip and deflate through
 * CompressionStream and nothing else, so gzip is the one codec every client we
 * ship can speak. fmweb-be decodes more than that, but nothing here sends it.
 */

/** Under this, the Content-Encoding header costs more than the gzip saves. Matches the SDK webhook's floor. */
export const MIN_COMPRESS_BYTES = 4096;

/** Files at or above this size get probed instead of compressed on spec. */
export const PROBE_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** How much of a large body the probe looks at. */
export const PROBE_SAMPLE_BYTES = 2 * 1024 * 1024;

/** Probe cheaply: this is a go/no-go answer, not the payload. */
export const PROBE_LEVEL = 1;

/** A probe that saves less than this means the body is already compressed. */
export const PROBE_MIN_SAVINGS = 0.05;

export interface UploadBody {
  /** The bytes to send. */
  readonly body: Buffer;
  /** Content-Type with the multipart boundary, plus Content-Encoding when compressed. */
  readonly headers: Record<string, string>;
  /** Whether `body` is gzipped. */
  readonly compressed: boolean;
  /** Size of the multipart envelope before compression. */
  readonly rawBytes: number;
}

function gzipAt(buffer: Buffer, level: number): Buffer {
  return gzipSync(buffer, { level });
}

/**
 * Whether gzipping the whole body is likely to be worth the CPU.
 *
 * A 50MB already-compressed file (a zip, a PDF, a JPEG) would otherwise cost a
 * full gzip pass to learn that gzip does not help it. Probing the leading 2MB
 * answers that in milliseconds.
 */
export function worthCompressing(envelope: Buffer): boolean {
  if (envelope.length < MIN_COMPRESS_BYTES) return false;
  if (envelope.length < PROBE_THRESHOLD_BYTES) return true;

  const sample = envelope.subarray(0, PROBE_SAMPLE_BYTES);
  const probe = gzipAt(sample, PROBE_LEVEL);
  return probe.length <= sample.length * (1 - PROBE_MIN_SAVINGS);
}

/**
 * Turn a FormData into the bytes and headers to send.
 *
 * fetch() would build the multipart envelope itself and set the boundary, but
 * it cannot compress. Building the envelope here gets us both the bytes to
 * gzip and the exact Content-Type that describes them.
 */
export async function buildUploadBody(form: FormData): Promise<UploadBody> {
  const built = new Request('http://upload.invalid/', { method: 'POST', body: form });
  const contentType = built.headers.get('content-type') ?? 'multipart/form-data';
  const envelope = Buffer.from(await built.arrayBuffer());
  const plain: UploadBody = {
    body: envelope,
    headers: { 'Content-Type': contentType },
    compressed: false,
    rawBytes: envelope.length,
  };

  if (!worthCompressing(envelope)) return plain;

  const compressed = gzipAt(envelope, constants.Z_DEFAULT_COMPRESSION);
  // The probe can be wrong about the tail. Send whichever is actually smaller.
  if (compressed.length >= envelope.length) return plain;

  return {
    body: compressed,
    headers: { 'Content-Type': contentType, 'Content-Encoding': 'gzip' },
    compressed: true,
    rawBytes: envelope.length,
  };
}
