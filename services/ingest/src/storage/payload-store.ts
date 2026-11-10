import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { uuidv7 } from "../uuid.ts";
import {
  appendJsonLine,
  readJsonLinesFile,
  resolveInside,
  sizeIfExists,
  syncDir,
  syncFile,
} from "./files.ts";
import {
  encodeFrame,
  encodeSegmentHeader,
  IDENTITY_ENCODING,
  PATCH_ENCODING,
  probeSegmentHeader,
  SEGMENT_FORMAT,
  STORAGE_FORMAT_VERSION,
} from "./frame.ts";
import {
  objectKey,
  rawFilePath,
  rotatedSegment,
  type SegmentLocation,
  type SegmentPeriod,
  segmentLocation,
} from "./paths.ts";
import type { FetchRecord, Outcome, StoredObject, Writer } from "./sidecar.ts";

export type RecordDraft = Omit<
  FetchRecord,
  "outcome" | "object" | "sameAs" | "sha256" | "bytes"
> & {
  readonly outcome?: FetchRecord["outcome"];
};

export interface LastObject {
  readonly sha256: string;
  readonly key: string;
}

interface OpenSegment {
  readonly location: SegmentLocation;
  readonly file: string;
  readonly handle: FileHandle;
  end: number;
  nextSeq: number;
  previous: { readonly seq: number; readonly payload: Buffer } | null;
}

export interface PayloadStoreOptions {
  readonly root: string;
  readonly source: string;
  readonly writer: Writer;
  readonly period: SegmentPeriod;
  readonly contentType: string;
  readonly last?: LastObject | null;
  readonly random?: () => Uint8Array;
  readonly onRotate?: (from: string, to: string, reason: string) => void;
}

type Serialized = <T>(task: () => Promise<T>) => Promise<T>;

function createSerializer(): Serialized {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** One compression at a time across all stores bounds the memory a large patch frame needs. */
const compressionQueue = createSerializer();

const MAX_ROTATIONS = 100;

/** A payload the scanner rejected is still stored, but keeps its `invalid` outcome. */
function storedOutcome(draft: RecordDraft, unchanged: boolean): Outcome {
  if (draft.outcome === "invalid") return "invalid";
  return unchanged ? "unchanged" : "stored";
}

interface Committed {
  readonly end: number | null;
  readonly nextSeq: number;
}

function committedIn(records: readonly FetchRecord[], file: string): Committed {
  let end: number | null = null;
  let nextSeq = 0;
  for (const record of records) {
    const object = record.object;
    if (object?.file !== file || object.offset === undefined || object.length === undefined) {
      continue;
    }
    end = Math.max(end ?? 0, object.offset + object.length);
    nextSeq = Math.max(nextSeq, (object.seq ?? 0) + 1);
  }
  return { end, nextSeq };
}

/**
 * Writes the payloads of one source and writer. Each stored payload is a zstd frame in the segment of
 * its UTC period, written and synced before its sidecar line; the sidecar line is the commit point.
 * A segment file holding committed frames is never rewritten: when its header cannot be appended to
 * (another format version, foreign bytes, or a file shorter than its committed frames), the store
 * rotates to `<HH>.<n>.seg.zst`.
 */
export class PayloadStore {
  private segment: OpenSegment | null = null;
  private last: LastObject | null;
  private readonly serialize = createSerializer();
  private readonly repairedSidecars = new Set<string>();
  private readonly options: PayloadStoreOptions;

  constructor(options: PayloadStoreOptions) {
    this.options = options;
    this.last = options.last ?? null;
  }

  get lastObject(): LastObject | null {
    return this.last;
  }

  note(draft: RecordDraft, atMs: number, extra: Partial<FetchRecord> = {}): Promise<FetchRecord> {
    return this.serialize(async () => {
      const record = { ...draft, outcome: draft.outcome ?? "failure", ...extra } as FetchRecord;
      await this.appendRecord(this.locate(atMs), record);
      return record;
    });
  }

  storePayload(
    draft: RecordDraft,
    payload: Buffer,
    sha256: string,
    atMs: number,
  ): Promise<FetchRecord> {
    return this.serialize(async () => {
      const location = this.locate(atMs);
      if (this.last?.sha256 === sha256) {
        const record: FetchRecord = {
          ...draft,
          outcome: storedOutcome(draft, true),
          sha256,
          bytes: payload.length,
          sameAs: this.last.key,
        };
        await this.appendRecord(location, record);
        return record;
      }
      const segment = await this.openSegment(location, atMs);
      const base = segment.previous;
      const frame = await compressionQueue(() => encodeFrame(payload, base?.payload ?? null));
      const offset = segment.end;
      await segment.handle.write(frame, 0, frame.length, offset);
      await segment.handle.datasync();
      const seq = segment.nextSeq;
      const object: StoredObject = {
        id: uuidv7(atMs, this.options.random?.()),
        key: objectKey(segment.file, seq),
        encoding: PATCH_ENCODING,
        file: segment.file,
        contentType: this.options.contentType,
        seq,
        base: base?.seq ?? null,
        offset,
        length: frame.length,
      };
      const record: FetchRecord = {
        ...draft,
        outcome: storedOutcome(draft, false),
        sha256,
        bytes: payload.length,
        object,
      };
      await this.appendRecord(location, record);
      segment.end = offset + frame.length;
      segment.nextSeq = seq + 1;
      segment.previous = { seq, payload };
      this.last = { sha256, key: object.key };
      return record;
    });
  }

  storeFile(
    draft: RecordDraft,
    tempPath: string,
    name: string,
    sha256: string,
    bytes: number,
    atMs: number,
  ): Promise<FetchRecord> {
    return this.serialize(async () => {
      const location = this.locate(atMs);
      if (this.last?.sha256 === sha256) {
        await rm(tempPath, { force: true });
        const record: FetchRecord = {
          ...draft,
          outcome: storedOutcome(draft, true),
          sha256,
          bytes,
          sameAs: this.last.key,
        };
        await this.appendRecord(location, record);
        return record;
      }
      const file = rawFilePath(this.options.source, atMs, name);
      const target = resolveInside(this.options.root, file);
      await mkdir(dirname(target), { recursive: true });
      await syncFile(tempPath);
      await rename(tempPath, target);
      await syncDir(dirname(target));
      const object: StoredObject = {
        id: uuidv7(atMs, this.options.random?.()),
        key: file,
        encoding: IDENTITY_ENCODING,
        file,
        contentType: this.options.contentType,
      };
      const record: FetchRecord = {
        ...draft,
        outcome: storedOutcome(draft, false),
        sha256,
        bytes,
        object,
      };
      await this.appendRecord(location, record);
      this.last = { sha256, key: file };
      return record;
    });
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      await this.segment?.handle.close();
      this.segment = null;
    });
  }

  private locate(atMs: number): SegmentLocation {
    return segmentLocation(this.options.source, atMs, this.options.period, this.options.writer);
  }

  private async appendRecord(location: SegmentLocation, record: FetchRecord): Promise<void> {
    await appendJsonLine(
      resolveInside(this.options.root, location.sidecar),
      record,
      this.repairedSidecars,
    );
  }

  private async openSegment(location: SegmentLocation, atMs: number): Promise<OpenSegment> {
    if (this.segment?.location.segment === location.segment) {
      return this.segment;
    }
    await this.segment?.handle.close();
    this.segment = null;
    const records = await readJsonLinesFile<FetchRecord>(
      resolveInside(this.options.root, location.sidecar),
    );
    for (let n = 0; n < MAX_ROTATIONS; n += 1) {
      const file = rotatedSegment(location.segment, n);
      const opened = await this.tryOpen(location, file, committedIn(records, file), atMs);
      if (typeof opened !== "string") {
        this.segment = opened;
        return opened;
      }
      this.options.onRotate?.(file, rotatedSegment(location.segment, n + 1), opened);
    }
    throw new Error(`${location.segment}: no usable segment file after ${MAX_ROTATIONS} rotations`);
  }

  /** The segment opened for appending, or why this file must be left as it is. */
  private async tryOpen(
    location: SegmentLocation,
    file: string,
    committed: Committed,
    atMs: number,
  ): Promise<OpenSegment | string> {
    const path = resolveInside(this.options.root, file);
    await mkdir(dirname(path), { recursive: true });
    const size = (await sizeIfExists(path)) ?? 0;
    if (size === 0 && committed.end !== null) return "committed frames point into a missing file";
    const handle = await open(path, size === 0 ? "w+" : "r+");
    const probe =
      size === 0 ? ({ status: "torn" } as const) : await probeSegmentHeader(handle, size);
    if (probe.status === "torn" && committed.end === null) {
      const end = await this.writeHeader(handle, atMs);
      if (size === 0) await syncDir(dirname(path));
      return { location, file, handle, end, nextSeq: committed.nextSeq, previous: null };
    }
    const reason = this.refusal(probe, size, committed);
    if (reason !== null) {
      await handle.close();
      return reason;
    }
    const end = committed.end ?? (probe.status === "valid" ? probe.length : 0);
    if (size > end) await handle.truncate(end);
    return { location, file, handle, end, nextSeq: committed.nextSeq, previous: null };
  }

  private refusal(
    probe: Awaited<ReturnType<typeof probeSegmentHeader>>,
    size: number,
    committed: Committed,
  ): string | null {
    if (probe.status === "torn") return "header torn although frames are committed";
    if (probe.status === "foreign") return probe.reason;
    if (probe.header.version !== STORAGE_FORMAT_VERSION) {
      return `segment format version ${probe.header.version}`;
    }
    if (probe.header.source !== this.options.source) return `segment of ${probe.header.source}`;
    if (committed.end !== null && size < committed.end)
      return "file shorter than its committed frames";
    return null;
  }

  private async writeHeader(handle: FileHandle, atMs: number): Promise<number> {
    const header = encodeSegmentHeader({
      format: SEGMENT_FORMAT,
      version: STORAGE_FORMAT_VERSION,
      source: this.options.source,
      writer: this.options.writer,
      createdAt: new Date(atMs).toISOString(),
    });
    await handle.truncate(0);
    await handle.write(header, 0, header.length, 0);
    await handle.datasync();
    return header.length;
  }
}
