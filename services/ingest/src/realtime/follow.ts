import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { listDirIfExists, resolveInside } from "../storage/files.ts";
import { decodeFrame, MAX_PAYLOAD_BYTES, PATCH_ENCODING } from "../storage/frame.ts";
import { SIDECAR_PATTERN } from "../storage/paths.ts";
import { readSegmentPayloads } from "../storage/reader.ts";
import type { FetchRecord } from "../storage/sidecar.ts";
import { compareRecords } from "./payload-stream.ts";

const DAY_MS = 86_400_000;
/** The longest sidecar line we read; a longer one is cut off and skipped. */
const MAX_LINE_BYTES = 1024 * 1024;

interface TrackedFile {
  readonly date: string;
  offset: number;
  partial: string;
  /** Inside a line longer than the limit: its rest up to the next newline is dropped too. */
  skipping: boolean;
}

interface Decoded {
  readonly seq: number;
  readonly payload: Buffer;
}

const observedOf = (record: FetchRecord): number => Date.parse(record.observedAt);

/**
 * Follows the recorder's sidecar files of some sources as they grow: each poll returns the stored
 * realtime payloads (patch segments) appended since the last poll, from the live writer and from
 * backfills of earlier hours alike. Payloads observed before `since` are known (their segments need
 * them to decode later frames) but never returned.
 */
export class RecordingFollower {
  readonly root: string;
  readonly sources: readonly string[];
  readonly bySegment = new Map<string, FetchRecord[]>();
  private since: number;
  private readonly files = new Map<string, TrackedFile>();
  private readonly byId = new Map<string, FetchRecord>();
  private readonly decoded = new Map<string, Decoded>();
  private skippedLines = 0;

  constructor(root: string, sources: readonly string[], since: number) {
    this.root = root;
    this.sources = sources;
    this.since = since;
  }

  trackedFiles(): number {
    return this.files.size;
  }

  knownRecords(): number {
    return this.byId.size;
  }

  /** Bytes of the decoded payloads kept for the next frame of their segments. */
  decodedBytes(): number {
    let bytes = 0;
    for (const item of this.decoded.values()) bytes += item.payload.length;
    return bytes;
  }

  /**
   * The whole lines of `text`; keeps the unfinished last one for the next read, and drops a line
   * longer than the limit (counted once) up to its newline.
   */
  private completeLines(tracked: TrackedFile, text: string): string[] {
    let whole = text;
    if (tracked.skipping) {
      const lineEnd = whole.indexOf("\n");
      if (lineEnd < 0) {
        tracked.partial = "";
        return [];
      }
      whole = whole.slice(lineEnd + 1);
      tracked.skipping = false;
    }
    const end = whole.lastIndexOf("\n");
    tracked.partial = whole.slice(end + 1);
    if (tracked.partial.length > MAX_LINE_BYTES) {
      tracked.partial = "";
      tracked.skipping = true;
      this.skippedLines += 1;
    }
    return whole.slice(0, end + 1).split("\n");
  }

  /** Sidecar lines skipped since the last call because they were too long or not JSON. */
  takeSkippedLines(): number {
    const skipped = this.skippedLines;
    this.skippedLines = 0;
    return skipped;
  }

  find(id: string): FetchRecord | undefined {
    return this.byId.get(id);
  }

  /** Stored payloads appended to the followed sidecars since the last poll, oldest first. */
  async poll(): Promise<FetchRecord[]> {
    const fresh: FetchRecord[] = [];
    const firstDate = new Date(this.since - DAY_MS).toISOString().slice(0, 10);
    for (const source of this.sources) {
      const dates = (await listDirIfExists(join(this.root, source)))
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name >= firstDate)
        .sort();
      for (const date of dates) {
        const names = (await listDirIfExists(join(this.root, source, date)))
          .filter((name) => SIDECAR_PATTERN.test(`${date}/${name}`))
          .sort();
        for (const name of names) {
          for (const record of await this.readNew(`${source}/${date}/${name}`, date)) {
            if (observedOf(record) >= this.since) fresh.push(record);
          }
        }
      }
    }
    return fresh.sort(compareRecords);
  }

  private async readNew(path: string, date: string): Promise<FetchRecord[]> {
    const full = resolveInside(this.root, path);
    const size = (await stat(full)).size;
    const tracked = this.files.get(path) ?? { date, offset: 0, partial: "", skipping: false };
    this.files.set(path, tracked);
    if (size <= tracked.offset) return [];
    const handle = await open(full, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - tracked.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tracked.offset);
      tracked.offset += bytesRead;
      text = tracked.partial + buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const records: FetchRecord[] = [];
    for (const line of this.completeLines(tracked, text)) {
      const record = parseRecord(line);
      if (record === "unreadable") {
        this.skippedLines += 1;
        continue;
      }
      if (!record?.object || record.object.encoding !== PATCH_ENCODING) continue;
      if (this.byId.has(record.object.id)) continue;
      this.byId.set(record.object.id, record);
      const list = this.bySegment.get(record.object.file) ?? [];
      list.push(record);
      this.bySegment.set(record.object.file, list);
      records.push(record);
    }
    return records;
  }

  /**
   * The payload bytes of a stored record: one frame against the frame before it when that one was
   * the last decoded in its segment, else the segment from its start.
   */
  async decode(record: FetchRecord): Promise<Buffer> {
    const object = record.object;
    if (!object) throw new Error("record has no stored object");
    const base = object.base ?? null;
    const previous = this.decoded.get(object.file);
    let payload: Buffer;
    if (base === null || previous?.seq === base) {
      payload = await this.readFrame(record, base === null ? null : (previous?.payload ?? null));
    } else {
      payload = await this.decodeFromStart(record);
    }
    const seq = object.seq ?? 0;
    if (!previous || seq >= previous.seq) this.keepDecoded(object.file, seq, payload);
    return payload;
  }

  /** Keeps the newest decoded payload of a segment, for the frame after it (two segments per source). */
  private keepDecoded(file: string, seq: number, payload: Buffer): void {
    this.decoded.delete(file);
    this.decoded.set(file, { seq, payload });
    while (this.decoded.size > 2 * this.sources.length) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) break;
      this.decoded.delete(oldest);
    }
  }

  private async readFrame(record: FetchRecord, basePayload: Buffer | null): Promise<Buffer> {
    const object = record.object;
    const offset = object?.offset ?? -1;
    const length = object?.length ?? -1;
    if (offset < 0 || length <= 0 || length > MAX_PAYLOAD_BYTES) {
      throw new Error(`${object?.key}: frame of ${length} B at ${offset} is not readable`);
    }
    const handle = await open(resolveInside(this.root, object?.file ?? ""), "r");
    try {
      const frame = Buffer.alloc(length);
      const { bytesRead } = await handle.read(frame, 0, length, offset);
      if (bytesRead !== length) throw new Error(`${object?.key}: frame cut short`);
      return decodeFrame(frame, basePayload, record.bytes ?? MAX_PAYLOAD_BYTES);
    } finally {
      await handle.close();
    }
  }

  private async decodeFromStart(record: FetchRecord): Promise<Buffer> {
    const file = record.object?.file ?? "";
    const seq = record.object?.seq ?? 0;
    const chain = (this.bySegment.get(file) ?? []).filter((item) => (item.object?.seq ?? 0) <= seq);
    for await (const item of readSegmentPayloads(this.root, file, chain)) {
      if (item.record.object?.id === record.object?.id) return item.payload;
    }
    throw new Error(`${record.object?.key}: not found in its segment`);
  }

  /** Forgets segments whose newest payload is older than `before`, and returns nothing older. */
  forget(before: number): void {
    this.since = Math.max(this.since, before);
    const keepDate = new Date(before - DAY_MS).toISOString().slice(0, 10);
    for (const [file, records] of [...this.bySegment]) {
      if (records.some((record) => observedOf(record) >= before)) continue;
      this.bySegment.delete(file);
      this.decoded.delete(file);
      for (const record of records) if (record.object) this.byId.delete(record.object.id);
    }
    for (const [path, tracked] of [...this.files]) {
      if (tracked.date < keepDate) this.files.delete(path);
    }
  }
}

/** A fetch record; null for an empty line or another record type; `unreadable` when it cannot be read. */
function parseRecord(line: string): FetchRecord | null | "unreadable" {
  if (line.trim() === "") return null;
  if (line.length > MAX_LINE_BYTES) return "unreadable";
  try {
    const value = JSON.parse(line) as FetchRecord;
    return value.type === "fetch" ? value : null;
  } catch {
    return "unreadable";
  }
}
