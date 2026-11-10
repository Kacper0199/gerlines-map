import type { FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

export const SEGMENT_FORMAT = "gerlines-segment";
export const STORAGE_FORMAT_VERSION = 1;
export const PATCH_ENCODING = "zstd-patch-v1";
export const IDENTITY_ENCODING = "identity";

const SKIPPABLE_MAGIC = 0x184d2a50;
const COMPRESSION_LEVEL = 9;
const MIN_WINDOW_LOG = 20;
const MAX_WINDOW_LOG = 27;
const DECODER_WINDOW_LOG_MAX = 31;

const zstdCompress = promisify(zlib.zstdCompress);
const { constants } = zlib;

export function windowLogFor(largestInput: number): number {
  const needed = Math.ceil(Math.log2(Math.max(1, largestInput) * 2));
  return Math.min(MAX_WINDOW_LOG, Math.max(MIN_WINDOW_LOG, needed));
}

/**
 * One zstd frame per payload. With a base (the previous payload of the same segment) the base is a
 * raw-content dictionary, so the frame stores mostly what changed (zstd patch-from).
 */
export async function encodeFrame(payload: Buffer, base: Buffer | null): Promise<Buffer> {
  const params = {
    [constants.ZSTD_c_compressionLevel]: COMPRESSION_LEVEL,
    [constants.ZSTD_c_windowLog]: windowLogFor(Math.max(payload.length, base?.length ?? 0)),
    [constants.ZSTD_c_enableLongDistanceMatching]: 1,
    [constants.ZSTD_c_checksumFlag]: 1,
    [constants.ZSTD_c_contentSizeFlag]: 1,
  };
  return base
    ? zstdCompress(payload, { params, dictionary: base })
    : zstdCompress(payload, { params });
}

/** Frames and payloads above this are refused when reading, whatever a sidecar claims. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024;

/** Decodes one frame; output beyond `expectedBytes` (the length the sidecar recorded) is refused. */
export function decodeFrame(frame: Buffer, base: Buffer | null, expectedBytes: number): Buffer {
  const params = { [constants.ZSTD_d_windowLogMax]: DECODER_WINDOW_LOG_MAX };
  const maxOutputLength = Math.min(Math.max(1, expectedBytes), MAX_PAYLOAD_BYTES);
  return base
    ? zlib.zstdDecompressSync(frame, { params, dictionary: base, maxOutputLength })
    : zlib.zstdDecompressSync(frame, { params, maxOutputLength });
}

export interface SegmentHeader {
  readonly format: typeof SEGMENT_FORMAT;
  readonly version: number;
  readonly source: string;
  readonly writer: string;
  readonly createdAt: string;
}

/** A zstd skippable frame holding the segment header as JSON; standard zstd tools skip it. */
export function encodeSegmentHeader(header: SegmentHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(SKIPPABLE_MAGIC, 0);
  prefix.writeUInt32LE(json.length, 4);
  return Buffer.concat([prefix, json]);
}

export function decodeSegmentHeader(bytes: Buffer): { header: SegmentHeader; length: number } {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== SKIPPABLE_MAGIC) {
    throw new Error("segment does not start with a GerLines header frame");
  }
  const length = bytes.readUInt32LE(4);
  if (bytes.length < 8 + length) {
    throw new Error("segment header frame is truncated");
  }
  const header = JSON.parse(bytes.subarray(8, 8 + length).toString("utf8")) as SegmentHeader;
  if (header.format !== SEGMENT_FORMAT) {
    throw new Error(`unknown segment format ${String(header.format)}`);
  }
  if (header.version > STORAGE_FORMAT_VERSION) {
    throw new Error(`segment format version ${header.version} is newer than this reader`);
  }
  return { header, length: 8 + length };
}

const MAX_HEADER_BYTES = 64 * 1024;

export type HeaderProbe =
  | { readonly status: "valid"; readonly header: SegmentHeader; readonly length: number }
  | { readonly status: "torn" }
  | { readonly status: "foreign"; readonly reason: string };

/**
 * Reads the header frame of a segment file whatever its length. `torn` means the file ends inside a
 * header of ours (an interrupted create); `foreign` means it is not a header this reader may append to.
 */
export async function probeSegmentHeader(handle: FileHandle, size: number): Promise<HeaderProbe> {
  const prefix = Buffer.alloc(8);
  const { bytesRead } = await handle.read(prefix, 0, 8, 0);
  if (bytesRead < 8) return { status: "torn" };
  if (prefix.readUInt32LE(0) !== SKIPPABLE_MAGIC) {
    return { status: "foreign", reason: "no GerLines header frame" };
  }
  const length = prefix.readUInt32LE(4);
  if (length > MAX_HEADER_BYTES) return { status: "foreign", reason: "header frame too long" };
  if (size < 8 + length) return { status: "torn" };
  const bytes = Buffer.alloc(8 + length);
  await handle.read(bytes, 0, bytes.length, 0);
  try {
    return { status: "valid", ...decodeSegmentHeader(bytes) };
  } catch (error) {
    return { status: "foreign", reason: error instanceof Error ? error.message : String(error) };
  }
}
