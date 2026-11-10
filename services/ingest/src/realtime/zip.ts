import { readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_MEMBER_BYTES = 1 << 30;
/** Inflated bytes one archive may yield in all (a gtfs.de static inflates to 84 MB). */
export const MAX_ARCHIVE_INFLATED_BYTES = 1 << 30;
/** Largest archive file read into memory. */
const MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024;

export interface ZipLimits {
  readonly maxInflatedBytes: number;
}

interface Member {
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Reads members of a ZIP archive (stored or deflated, no ZIP64), as GTFS feeds are packed. */
export class ZipArchive {
  private readonly bytes: Buffer;
  private readonly members = new Map<string, Member>();
  private readonly maxInflatedBytes: number;
  private inflated = 0;

  private constructor(bytes: Buffer, limits: ZipLimits) {
    this.bytes = bytes;
    this.maxInflatedBytes = limits.maxInflatedBytes;
    this.readDirectory();
    const declared = [...this.members.values()].reduce((sum, member) => sum + member.size, 0);
    if (declared > this.maxInflatedBytes) this.refuseSize();
  }

  static async open(
    path: string,
    limits: ZipLimits = { maxInflatedBytes: MAX_ARCHIVE_INFLATED_BYTES },
  ): Promise<ZipArchive> {
    const { size } = await stat(path);
    if (size > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error(`zip archive is larger than ${MAX_ARCHIVE_FILE_BYTES} bytes`);
    }
    return new ZipArchive(await readFile(path), limits);
  }

  static fromBytes(
    bytes: Buffer,
    limits: ZipLimits = { maxInflatedBytes: MAX_ARCHIVE_INFLATED_BYTES },
  ): ZipArchive {
    return new ZipArchive(bytes, limits);
  }

  private refuseSize(): never {
    throw new Error(`zip archive inflates to more than ${this.maxInflatedBytes} bytes`);
  }

  names(): string[] {
    return [...this.members.keys()];
  }

  has(name: string): boolean {
    return this.members.has(name);
  }

  read(name: string): Buffer {
    const member = this.members.get(name);
    if (!member) throw new Error(`zip member ${name} not found`);
    const local = member.localOffset;
    if (local + 30 > this.bytes.length)
      throw new Error(`zip member ${name}: data outside the archive`);
    if (this.bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new Error(`zip member ${name}: bad local header`);
    }
    const start =
      local + 30 + this.bytes.readUInt16LE(local + 26) + this.bytes.readUInt16LE(local + 28);
    if (start + member.compressedSize > this.bytes.length) {
      throw new Error(`zip member ${name}: data outside the archive`);
    }
    const data = this.bytes.subarray(start, start + member.compressedSize);
    if (member.method !== 0 && member.method !== 8) {
      throw new Error(`zip member ${name}: method ${member.method}`);
    }
    const room = this.maxInflatedBytes - this.inflated;
    if (member.size > room) this.refuseSize();
    const output = member.method === 0 ? Buffer.from(data) : this.inflate(name, data, member.size);
    this.inflated += output.length;
    return output;
  }

  private inflate(name: string, data: Buffer, size: number): Buffer {
    try {
      return inflateRawSync(data, {
        maxOutputLength: Math.max(1, Math.min(size, MAX_MEMBER_BYTES)),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new Error(`zip member ${name} inflates past its declared size`);
      }
      throw error;
    }
  }

  private readDirectory(): void {
    const bytes = this.bytes;
    let eocd = -1;
    for (
      let offset = bytes.length - 22;
      offset >= Math.max(0, bytes.length - 65_557);
      offset -= 1
    ) {
      if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");
    const count = bytes.readUInt16LE(eocd + 10);
    let offset = bytes.readUInt32LE(eocd + 16);
    const corrupt = () => new Error("zip central directory is corrupt");
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw corrupt();
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      if (offset + 46 + nameLength > eocd) throw corrupt();
      const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
      this.members.set(name, {
        method: bytes.readUInt16LE(offset + 10),
        compressedSize: bytes.readUInt32LE(offset + 20),
        size: bytes.readUInt32LE(offset + 24),
        localOffset: bytes.readUInt32LE(offset + 42),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }
}

function splitQuotedLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Calls `onRow` with the fields of every data row of a CSV file and a lookup of column positions.
 * Quoted fields and doubled quotes are read; GTFS files never break a field across lines.
 */
export function forEachCsvRow(
  text: string,
  onRow: (fields: readonly string[], column: (name: string) => number) => void,
): void {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const header = splitQuotedLine(lines[0] ?? "");
  const positions = new Map(header.map((name, index) => [name.trim(), index]));
  const column = (name: string) => positions.get(name) ?? -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") continue;
    onRow(line.includes('"') ? splitQuotedLine(line) : line.split(","), column);
  }
}

/** Parses a small CSV file into rows keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let names: string[] | undefined;
  forEachCsvRow(text, (fields, column) => {
    names ??= splitQuotedLine(text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "").map((name) =>
      name.trim(),
    );
    rows.push(Object.fromEntries(names.map((name) => [name, fields[column(name)] ?? ""])));
  });
  return rows;
}
