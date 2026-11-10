import { createHash } from "node:crypto";
import { errorMessage } from "./log.ts";
import { readJsonLinesDetailed, resolveInside } from "./storage/files.ts";
import { IDENTITY_ENCODING, PATCH_ENCODING } from "./storage/frame.ts";
import {
  listSidecars,
  readFetchRecords,
  readSegmentPayloads,
  sha256OfFile,
} from "./storage/reader.ts";
import { readPrunedFiles } from "./storage/retention.ts";
import type { FetchRecord } from "./storage/sidecar.ts";

export interface VerifyReport {
  readonly source: string;
  readonly records: number;
  readonly checked: number;
  readonly matched: number;
  readonly mismatched: string[];
  readonly errors: string[];
  readonly unchangedResolved: number;
  readonly unchangedOutsideWindow: number;
  /** Payloads in files that retention deleted on purpose (`retention.jsonl`), not checked. */
  readonly pruned: number;
  readonly payloadBytes: number;
  readonly storedBytes: number;
}

export interface VerifyWindow {
  readonly from?: number;
  readonly to?: number;
}

function inWindow(record: FetchRecord, window: VerifyWindow): boolean {
  const at = Date.parse(record.startedAt);
  return (
    (window.from === undefined || at >= window.from) && (window.to === undefined || at < window.to)
  );
}

async function verifySegment(
  root: string,
  segment: string,
  records: readonly FetchRecord[],
  report: VerifyReport & { mismatched: string[]; errors: string[] },
  counts: { checked: number; matched: number },
): Promise<void> {
  try {
    for await (const { record, payload } of readSegmentPayloads(root, segment, records)) {
      counts.checked += 1;
      const actual = createHash("sha256").update(payload).digest("hex");
      if (actual === record.sha256 && payload.length === record.bytes) counts.matched += 1;
      else report.mismatched.push(record.object?.key ?? "?");
    }
  } catch (error) {
    report.errors.push(`${segment}: ${errorMessage(error)}`);
  }
}

/** Every object key in every sidecar of the source; unreadable sidecar lines are reported as errors. */
async function allObjectKeys(root: string, source: string, errors: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const sidecar of await listSidecars(root, source)) {
    const parsed = await readJsonLinesDetailed<FetchRecord>(resolveInside(root, sidecar.path));
    for (const line of parsed.badLines) errors.push(`${sidecar.path}:${line}: not a JSON line`);
    for (const record of parsed.values) if (record.object) keys.add(record.object.key);
  }
  return keys;
}

/**
 * Recovers every payload stored in the window and compares its sha256 and length with its sidecar.
 * A `sameAs` that names no stored object anywhere, and an unreadable sidecar line, are errors.
 * Segments are decoded from their start, since each frame needs the one before it.
 */
export async function verifySource(
  root: string,
  source: string,
  window: VerifyWindow = {},
): Promise<VerifyReport> {
  const since =
    window.from === undefined
      ? undefined
      : new Date(window.from - 86_400_000).toISOString().slice(0, 10);
  const all = await readFetchRecords(root, await listSidecars(root, source, since));
  const selected = all.filter((record) => inWindow(record, window));
  const report = {
    source,
    records: selected.length,
    checked: 0,
    matched: 0,
    mismatched: [] as string[],
    errors: [] as string[],
    unchangedResolved: 0,
    unchangedOutsideWindow: 0,
    pruned: 0,
    payloadBytes: 0,
    storedBytes: 0,
  };
  const counts = { checked: 0, matched: 0 };
  const prunedFiles = await readPrunedFiles(root);
  const isPruned = (record: FetchRecord) => prunedFiles.has(record.object?.file ?? "");
  report.pruned = selected.filter(isPruned).length;
  const stored = selected.filter((record) => record.object && !isPruned(record));
  const segments = new Set(
    stored
      .filter((record) => record.object?.encoding === PATCH_ENCODING)
      .map((record) => record.object?.file ?? ""),
  );
  for (const segment of segments) {
    await verifySegment(
      root,
      segment,
      all.filter((record) => record.object?.file === segment),
      report,
      counts,
    );
  }
  for (const record of stored.filter((r) => r.object?.encoding === IDENTITY_ENCODING)) {
    counts.checked += 1;
    const actual = await sha256OfFile(resolveInside(root, record.object?.file ?? "")).catch(
      () => null,
    );
    if (actual?.sha256 === record.sha256) counts.matched += 1;
    else report.mismatched.push(record.object?.key ?? "?");
  }
  const nearby = new Set(all.flatMap((record) => (record.object ? [record.object.key] : [])));
  const everywhere = await allObjectKeys(root, source, report.errors);
  for (const record of selected.filter((r) => r.sameAs !== undefined)) {
    const key = record.sameAs ?? "";
    if (nearby.has(key)) report.unchangedResolved += 1;
    else if (everywhere.has(key)) report.unchangedOutsideWindow += 1;
    else report.errors.push(`${record.startedAt}: sameAs ${key} names no stored object`);
  }
  report.payloadBytes = stored.reduce((sum, record) => sum + (record.bytes ?? 0), 0);
  report.storedBytes = stored.reduce(
    (sum, record) => sum + (record.object?.length ?? record.bytes ?? 0),
    0,
  );
  return { ...report, checked: counts.checked, matched: counts.matched };
}
