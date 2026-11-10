const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

export interface TarOptions {
  /** An entry larger than this fails the read instead of being held in memory. */
  readonly maxEntryBytes: number;
  /** A GNU long-name or pax record larger than this fails the read. */
  readonly maxNameBytes?: number;
  /** More headers than this fail the read. */
  readonly maxMembers?: number;
}

/** Filled in while reading: whether the zero end block was seen and the stream was drained after it. */
export interface TarEnd {
  endBlock: boolean;
}

const DEFAULT_MAX_NAME_BYTES = 1024;

/** Accumulates stream chunks and hands out exact byte counts. */
class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;
  private readonly source: AsyncIterator<Buffer | Uint8Array>;
  private done = false;

  constructor(source: AsyncIterable<Buffer | Uint8Array>) {
    this.source = source[Symbol.asyncIterator]();
  }

  /** Exactly `count` bytes, or null when the stream ends first (with the bytes left over). */
  async take(count: number): Promise<{ bytes: Buffer; complete: boolean }> {
    while (this.length < count && !this.done) {
      const next = await this.source.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const all =
      this.chunks.length === 1
        ? (this.chunks[0] as Buffer)
        : Buffer.concat(this.chunks, this.length);
    const size = Math.min(count, all.length);
    const bytes = Buffer.from(all.subarray(0, size));
    const rest = all.subarray(size);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return { bytes, complete: size === count };
  }

  /** Reads and drops whatever follows, so the source is consumed to its end. */
  async drain(): Promise<void> {
    this.chunks = [];
    this.length = 0;
    while (!this.done) {
      if ((await this.source.next()).done) this.done = true;
    }
  }

  async close(): Promise<void> {
    await this.source.return?.();
  }
}

function text(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function octal(field: Buffer): number {
  if ((field[0] ?? 0) & 0x80) {
    let value = 0;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = text(field).trim();
  return digits === "" ? 0 : Number.parseInt(digits, 8);
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum === octal(header.subarray(148, 156));
}

function paxPath(data: Buffer): string | null {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return null;
}

function headerName(header: Buffer): string {
  const name = text(header.subarray(0, 100));
  const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? text(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

interface TarRecord {
  readonly header: Buffer;
  readonly type: string;
  readonly data: Buffer;
}

const FILE_TYPES = new Set(["0", "\0"]);
const NAME_TYPES = new Set(["L", "x"]);

/** The next header and its data, or null at the end of the archive. */
async function readRecord(
  queue: ByteQueue,
  options: TarOptions,
  end: TarEnd,
): Promise<TarRecord | null> {
  const { bytes: header, complete } = await queue.take(BLOCK);
  if (!complete) {
    if (header.length === 0) return null;
    throw new Error("tar stream ends inside a header");
  }
  if (header.every((byte) => byte === 0)) {
    await queue.drain();
    end.endBlock = true;
    return null;
  }
  if (!checksumMatches(header)) throw new Error("tar header checksum does not match");
  const size = octal(header.subarray(124, 136));
  const type = String.fromCharCode(header[156] ?? 0x30);
  if (size > options.maxEntryBytes) {
    throw new Error(`tar entry of ${size} B exceeds ${options.maxEntryBytes} B`);
  }
  const maxName = options.maxNameBytes ?? DEFAULT_MAX_NAME_BYTES;
  if (NAME_TYPES.has(type) && size > maxName) {
    throw new Error(`tar name record of ${size} B exceeds ${maxName} B`);
  }
  const { bytes: body, complete: whole } = await queue.take(Math.ceil(size / BLOCK) * BLOCK);
  if (!whole) throw new Error("tar stream ends inside an entry");
  return { header, type, data: body.subarray(0, size) };
}

function nameFrom(record: TarRecord, current: string | null): string | null {
  if (record.type === "L") return text(record.data);
  return paxPath(record.data) ?? current;
}

/**
 * Regular files of a tar stream (ustar, GNU long names, pax paths), each held in memory up to
 * `maxEntryBytes`; directories and other entry types are skipped. The stream is read once, in order, and after
 * the end block to its end; `end.endBlock` tells a complete archive from one cut at an entry boundary.
 */
export async function* readTar(
  source: AsyncIterable<Buffer | Uint8Array>,
  options: TarOptions,
  end: TarEnd = { endBlock: false },
): AsyncGenerator<TarEntry> {
  const queue = new ByteQueue(source);
  let nextName: string | null = null;
  let members = 0;
  try {
    for (
      let record = await readRecord(queue, options, end);
      record;
      record = await readRecord(queue, options, end)
    ) {
      members += 1;
      if (options.maxMembers !== undefined && members > options.maxMembers) {
        throw new Error(`tar stream has more than ${options.maxMembers} members`);
      }
      if (NAME_TYPES.has(record.type)) {
        nextName = nameFrom(record, nextName);
        continue;
      }
      if (FILE_TYPES.has(record.type))
        yield { name: nextName ?? headerName(record.header), data: record.data };
      nextName = null;
    }
  } finally {
    await queue.close();
  }
}
