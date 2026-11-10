import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { listDirIfExists, readJsonLinesFile, resolveInside } from "./files.ts";
import { decodeFrame, MAX_PAYLOAD_BYTES, PATCH_ENCODING, probeSegmentHeader } from "./frame.ts";
import { SIDECAR_PATTERN } from "./paths.ts";
import type { FetchRecord } from "./sidecar.ts";

export interface SidecarFile {
  readonly source: string;
  readonly path: string;
  readonly date: string;
}

/** Every sidecar of a source, oldest first, optionally limited to UTC dates from `sinceDate` on. */
export async function listSidecars(
  root: string,
  source: string,
  sinceDate?: string,
): Promise<SidecarFile[]> {
  const dates = (await listDirIfExists(join(root, source)))
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && (!sinceDate || name >= sinceDate))
    .sort();
  const files: SidecarFile[] = [];
  for (const date of dates) {
    const names = (await listDirIfExists(join(root, source, date)))
      .filter((name) => SIDECAR_PATTERN.test(`${date}/${name}`))
      .sort();
    files.push(...names.map((name) => ({ source, date, path: `${source}/${date}/${name}` })));
  }
  return files;
}

export async function readFetchRecords(
  root: string,
  sidecars: readonly SidecarFile[],
): Promise<FetchRecord[]> {
  const records: FetchRecord[] = [];
  for (const sidecar of sidecars) {
    records.push(...(await readJsonLinesFile<FetchRecord>(resolveInside(root, sidecar.path))));
  }
  return records.filter((record) => record.type === "fetch");
}

export interface RecoveredPayload {
  readonly record: FetchRecord;
  readonly payload: Buffer;
}

/** Decodes the stored payloads of one patch segment in sequence order, each against its base. */
export async function* readSegmentPayloads(
  root: string,
  segment: string,
  records: readonly FetchRecord[],
): AsyncGenerator<RecoveredPayload> {
  const stored = records
    .filter(
      (record) => record.object?.file === segment && record.object.encoding === PATCH_ENCODING,
    )
    .sort((a, b) => (a.object?.seq ?? 0) - (b.object?.seq ?? 0));
  const handle = await open(resolveInside(root, segment), "r");
  try {
    const { size } = await handle.stat();
    const header = await probeSegmentHeader(handle, size);
    if (header.status !== "valid") {
      throw new Error(`${segment}: ${header.status === "foreign" ? header.reason : "header torn"}`);
    }
    let previous: Decoded | null = null;
    for (const record of stored) {
      previous = await decodeRecord(handle, size, record, previous);
      yield { record, payload: previous.payload };
    }
  } finally {
    await handle.close();
  }
}

interface Decoded {
  readonly seq: number;
  readonly payload: Buffer;
}

async function decodeRecord(
  handle: FileHandle,
  size: number,
  record: FetchRecord,
  previous: Decoded | null,
): Promise<Decoded> {
  const object = record.object;
  const offset = object?.offset ?? -1;
  const length = object?.length ?? -1;
  if (offset < 0 || length <= 0 || length > MAX_PAYLOAD_BYTES || offset + length > size) {
    throw new Error(`${object?.key}: frame of ${length} B at ${offset} outside the file`);
  }
  const base = object?.base ?? null;
  if (base !== null && previous?.seq !== base) {
    throw new Error(`${object?.key}: base ${base} was not decoded before it`);
  }
  const frame = Buffer.alloc(length);
  await handle.read(frame, 0, length, offset);
  const basePayload = base === null ? null : (previous?.payload ?? null);
  const payload = decodeFrame(frame, basePayload, record.bytes ?? MAX_PAYLOAD_BYTES);
  return { seq: object?.seq ?? 0, payload };
}

export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
