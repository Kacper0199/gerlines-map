import {
  ALL_CATEGORIES,
  CATEGORIES,
  type Category,
  HEAD_COUNTS_MINOR,
  HEAD_METRICS,
  MAX_U32,
  PACK_SETS_MINOR,
  SECTION,
} from "./constants.ts";
import {
  optionalSection,
  readContainer,
  type SectionInput,
  section,
  writeContainer,
} from "./container.ts";
import { requireInteger } from "./encode-util.ts";
import { corrupt } from "./errors.ts";
import type { Head, HeadCount, PackSets } from "./model.ts";

const KNOWN: ReadonlySet<number> = new Set([
  SECTION.head,
  SECTION.headCounts,
  SECTION.headPackSets,
]);

/** The most parts a base set may have. */
export const MAX_PACK_SET_PARTS = 64;

function packSetsProblem({ epoch, latest, first, parts }: PackSets): string | undefined {
  if (!(Number.isInteger(parts) && parts >= 1 && parts <= MAX_PACK_SET_PARTS)) {
    return `parts ${parts} outside 1 to ${MAX_PACK_SET_PARTS}`;
  }
  if (!(Number.isInteger(epoch) && epoch >= 1 && epoch <= MAX_U32)) return `epoch ${epoch}`;
  if (!(Number.isInteger(latest) && latest >= 0 && latest <= MAX_U32)) return `latest ${latest}`;
  if (!(Number.isInteger(first) && first >= 0 && first <= latest)) {
    return `first ${first} outside 0 to ${latest}`;
  }
  return undefined;
}

/** FORMAT.md section 4: 1 ≤ keyframe ≤ latest and 2 ≤ oldest ≤ keyframe + 1. */
function sequenceProblem(keyframe: number, latest: number, oldest: number): string | undefined {
  if (keyframe < 1 || keyframe > latest) return `keyframe ${keyframe} outside 1 to ${latest}`;
  if (oldest < 2 || oldest > keyframe + 1) {
    return `oldest delta ${oldest} outside 2 to ${keyframe + 1}: no path from the keyframe`;
  }
  return undefined;
}

function countCode(count: HeadCount): number {
  const metric = HEAD_METRICS.indexOf(count.metric);
  if (metric < 0) throw new RangeError(`unknown head metric ${String(count.metric)}`);
  if (count.category === null) return (metric + 1) * 256 + ALL_CATEGORIES;
  const category = CATEGORIES.indexOf(count.category);
  if (category < 0) throw new RangeError(`unknown category ${String(count.category)}`);
  return (metric + 1) * 256 + category;
}

function countSection(counts: readonly HeadCount[]): Uint32Array {
  const rows = counts
    .map((count) => ({
      code: countCode(count),
      value: requireInteger(count.count, 0, MAX_U32, `${count.metric} count`),
    }))
    .sort((a, b) => a.code - b.code);
  const data = new Uint32Array(rows.length * 2);
  rows.forEach((row, i) => {
    if (i > 0 && rows[i - 1]?.code === row.code) {
      throw new RangeError(`head count code 0x${row.code.toString(16)} repeated`);
    }
    data[2 * i] = row.code;
    data[2 * i + 1] = row.value;
  });
  return data;
}

function readCounts(values: Uint32Array): HeadCount[] {
  if (values.length % 2 !== 0) corrupt(`head counts hold ${values.length} values, not pairs`);
  const counts: HeadCount[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const code = values[i] as number;
    if (i > 0 && code <= (values[i - 2] as number)) corrupt("head count codes not ascending");
    const metric = HEAD_METRICS[(code >>> 8) - 1];
    const categoryCode = code & 0xff;
    const category: Category | null | undefined =
      categoryCode === ALL_CATEGORIES ? null : CATEGORIES[categoryCode];
    if (metric === undefined || category === undefined) continue;
    counts.push({ metric, category, count: values[i + 1] as number });
  }
  return counts;
}

/**
 * Encodes a head. With legend counts it writes version 1.1 and section 0x61, with pack sets 1.4
 * and section 0x62, without either the same bytes as 1.0.
 */
export function encodeHead(head: Head): Uint8Array<ArrayBuffer> {
  const problem = sequenceProblem(head.keyframeSequence, head.sequence, head.oldestSequence);
  if (problem) throw new RangeError(`head ${problem}`);
  const sections: SectionInput[] = [
    {
      id: SECTION.head,
      data: Uint32Array.from([head.keyframeSequence, head.sequence, head.oldestSequence]),
    },
  ];
  const counts = head.counts ?? [];
  if (counts.length > 0) sections.push({ id: SECTION.headCounts, data: countSection(counts) });
  const sets = head.packSets;
  if (sets) {
    const setProblem = packSetsProblem(sets);
    if (setProblem) throw new RangeError(`head pack sets ${setProblem}`);
    sections.push({
      id: SECTION.headPackSets,
      data: Uint32Array.from([sets.epoch, sets.latest, sets.first, sets.parts]),
    });
  }
  const minor = sets ? PACK_SETS_MINOR : counts.length > 0 ? HEAD_COUNTS_MINOR : undefined;
  return writeContainer(
    "head",
    { ...head, baseSequence: 0, shapeEpoch: 0 },
    sections,
    minor === undefined ? {} : { versionMinor: minor },
  );
}

/** Decodes and validates a head (FORMAT.md section 4); throws FrameDecodeError. */
export function decodeHead(input: ArrayBufferLike | ArrayBufferView): Head {
  const container = readContainer(input, "head", KNOWN);
  const values = section(container, SECTION.head, "u32");
  if (values.length !== 3) corrupt(`head section holds ${values.length} values`);
  const [keyframeSequence = 0, latest = 0, oldestSequence = 0] = values;
  const { sequence, timetableVersion, timeBase } = container.header;
  if (latest !== sequence) corrupt(`head latest ${latest} differs from sequence ${sequence}`);
  const problem = sequenceProblem(keyframeSequence, latest, oldestSequence);
  if (problem) corrupt(`head ${problem}`);
  const head: Head = {
    kind: "head",
    sequence,
    timetableVersion,
    timeBase,
    keyframeSequence,
    oldestSequence,
  };
  const counts = optionalSection(container, SECTION.headCounts, "u32");
  const sets = optionalSection(container, SECTION.headPackSets, "u32");
  const packSets = sets ? readPackSets(sets) : null;
  return {
    ...head,
    ...(counts ? { counts: readCounts(counts) } : {}),
    ...(packSets ? { packSets } : {}),
  };
}

/**
 * Section 0x62 read tolerantly: an optional section must never take the head down, so values a
 * later minor may add after the fourth are ignored and a section this decoder cannot use (too
 * short, or values out of range) reads as no pack sets.
 */
function readPackSets(values: Uint32Array): PackSets | null {
  if (values.length < 4) return null;
  const [epoch = 0, latest = 0, first = 0, parts = 0] = values;
  const sets = { epoch, latest, first, parts };
  return packSetsProblem(sets) ? null : sets;
}
