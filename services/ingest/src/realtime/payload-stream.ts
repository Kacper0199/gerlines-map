import { PATCH_ENCODING } from "../storage/frame.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads } from "../storage/reader.ts";
import type { FetchRecord } from "../storage/sidecar.ts";

export interface StoredPayload {
  readonly record: FetchRecord;
  readonly payload: Buffer;
}

const observed = (record: FetchRecord): number => Date.parse(record.observedAt);

/** Orders records by the instant they represent, then by object key, so ties never depend on input order. */
export function compareRecords(a: FetchRecord, b: FetchRecord): number {
  return observed(a) - observed(b) || (a.object?.key ?? "").localeCompare(b.object?.key ?? "");
}

/** Stored realtime payloads (patch segments only) of the given sources whose observed time is in the window. */
export async function recordsInWindow(
  root: string,
  sources: readonly string[],
  from: number,
  to: number,
): Promise<{ wanted: FetchRecord[]; bySegment: Map<string, FetchRecord[]> }> {
  const since = new Date(from - 86_400_000).toISOString().slice(0, 10);
  const wanted: FetchRecord[] = [];
  const bySegment = new Map<string, FetchRecord[]>();
  for (const source of sources) {
    for (const record of await readFetchRecords(root, await listSidecars(root, source, since))) {
      const file = record.object?.file;
      if (!file || record.object?.encoding !== PATCH_ENCODING) continue;
      const list = bySegment.get(file) ?? [];
      list.push(record);
      bySegment.set(file, list);
      const at = observed(record);
      if (at >= from && at < to) wanted.push(record);
    }
  }
  wanted.sort(compareRecords);
  return { wanted, bySegment };
}

interface OpenSegment {
  readonly iterator: AsyncGenerator<StoredPayload>;
  next: StoredPayload | undefined;
}

/** Moves a segment to its next payload that `wanted` names, or to its end. */
async function advance(segment: OpenSegment, wanted: ReadonlyMap<string, number>): Promise<void> {
  for (;;) {
    const step = await segment.iterator.next();
    if (step.done) {
      segment.next = undefined;
      return;
    }
    if (wanted.has(step.value.record.object?.id ?? "")) {
      segment.next = step.value;
      return;
    }
  }
}

/** Segment files of the records, by the first wanted instant in each. */
function segmentsByFirstRecord(records: readonly FetchRecord[]): { file: string; first: number }[] {
  const first = new Map<string, number>();
  for (const record of records) {
    const file = record.object?.file ?? "";
    first.set(file, Math.min(first.get(file) ?? Number.POSITIVE_INFINITY, observed(record)));
  }
  return [...first.entries()]
    .map(([file, at]) => ({ file, first: at }))
    .sort((a, b) => a.first - b.first);
}

function earliest(open: readonly OpenSegment[]): OpenSegment | undefined {
  let best: OpenSegment | undefined;
  for (const segment of open) {
    if (!segment.next) continue;
    if (!best?.next || compareRecords(segment.next.record, best.next.record) < 0) best = segment;
  }
  return best;
}

/**
 * Recovers the payloads of `records` in observation order (a record listed twice is yielded twice).
 * Each segment is decoded from its start, since every frame is a patch against the one before;
 * segments open only when the merge reaches them.
 */
export async function* payloadsInOrder(
  root: string,
  records: readonly FetchRecord[],
  bySegment: ReadonlyMap<string, readonly FetchRecord[]>,
): AsyncGenerator<StoredPayload> {
  const wanted = new Map<string, number>();
  for (const record of records) {
    const id = record.object?.id ?? "";
    wanted.set(id, (wanted.get(id) ?? 0) + 1);
  }
  const pending = segmentsByFirstRecord(records);
  let open: OpenSegment[] = [];
  for (;;) {
    const head = earliest(open);
    const upcoming = pending[0];
    if (upcoming && (!head?.next || upcoming.first <= observed(head.next.record))) {
      pending.shift();
      const segment: OpenSegment = {
        iterator: readSegmentPayloads(root, upcoming.file, bySegment.get(upcoming.file) ?? []),
        next: undefined,
      };
      await advance(segment, wanted);
      open.push(segment);
      continue;
    }
    if (!head?.next) return;
    const current = head.next;
    for (let copy = 0; copy < (wanted.get(current.record.object?.id ?? "") ?? 1); copy += 1) {
      yield current;
    }
    await advance(head, wanted);
    open = open.filter((segment) => segment.next);
  }
}
