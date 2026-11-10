import { readVarints, writeVarints } from "../src/compact.ts";
import { CATEGORIES, HEAD_METRICS, HEADER, SECTION } from "../src/constants.ts";
import { writeContainer } from "../src/container.ts";
import {
  type Delta,
  encodeDelta,
  encodeHead,
  encodeKeyframe,
  encodeShapePack,
  type FrameErrorCode,
  type Head,
  type HeadCount,
  type Keyframe,
  type ShapePack,
} from "../src/index.ts";
import {
  extended,
  rebuilt,
  resealed,
  sectionOffset,
  sectionsOf,
  u16,
  u32,
  unaligned,
} from "./craft.ts";
import {
  DELTA,
  DELTA_REMOVALS,
  DELTA_VEHICLE,
  HEAD,
  HEAD_COUNTS,
  KEYFRAME,
  KEYFRAME_LIMITS,
  KEYFRAME_NUMBERED,
  KEYFRAME_VEHICLE,
  PACK,
  PACK_NUMBERED,
  PACK_STUBS,
} from "./fixtures.ts";
import type { Decoder } from "./golden.ts";

/** A golden vector: `<name>.bin` and `<name>.json` in test-vectors/. */
export interface Vector {
  readonly name: string;
  readonly description: string;
  readonly decoder: Decoder;
  readonly expected?: Keyframe | Delta | Head | ShapePack;
  readonly error?: FrameErrorCode;
  readonly bytes: Uint8Array;
}

function sorted(frame: Keyframe): Keyframe {
  return { ...frame, trips: [...frame.trips].sort((a, b) => a.key - b.key) };
}

function futureMinor(bytes: Uint8Array): Uint8Array {
  return extended(
    bytes,
    [
      { id: 0x1a, data: Float32Array.from([88.5, 120, 0, 160]) },
      { id: 0x7f00, data: new TextEncoder().encode("ignored by 1.0 decoders") },
    ],
    { versionMinor: 3, headerLength: 48 },
  );
}

function sortedFrame<T extends Keyframe | Delta>(frame: T): T {
  const trips = [...frame.trips].sort((a, b) => a.key - b.key);
  if (frame.kind === "keyframe") return { ...frame, trips };
  return { ...frame, trips, removed: [...(frame as Delta).removed].sort((a, b) => a - b) };
}

const HEAD_PACK_SETS: Head = {
  ...HEAD_COUNTS,
  counts: countsInCodeOrder(),
  packSets: { epoch: 3, latest: 2_995_000, first: 2_994_996, parts: 7 },
};

const PACK_COMPACT: ShapePack = { ...PACK_STUBS, coding: "compact" };

/** shape-pack-basic in the compact coding with its first shape's last M step 1 cm short. */
function invalidCompactArc(): Uint8Array {
  const bytes = encodeShapePack({ ...PACK, coding: "compact" });
  const residual = readVarints(sectionsOf(bytes).get(SECTION.compactM) as Uint8Array, 5, "m");
  residual[2] = (residual[2] as number) - 1;
  return rebuilt(bytes, { [SECTION.compactM]: writeVarints(residual) });
}

function invalidHead(): Uint8Array {
  const meta = { sequence: 1001, baseSequence: 0, timetableVersion: 7, timeBase: HEAD.timeBase };
  return writeContainer("head", { ...meta, shapeEpoch: 0 }, [
    { id: SECTION.head, data: u32(990, 1001, 995) },
  ]);
}

function invalidStopFlags(keyframe: Uint8Array): Uint8Array {
  const flags = sectionsOf(keyframe).get(SECTION.stopFlags) ?? new Uint8Array(0);
  flags[1] = 3;
  return rebuilt(keyframe, { [SECTION.stopFlags]: flags });
}

export function goldenVectors(): Vector[] {
  const keyframe = encodeKeyframe(KEYFRAME);
  const keyOffset = sectionOffset(keyframe, SECTION.tripKey);
  return [
    {
      name: "keyframe-basic",
      description:
        "Four trips: realtime and timetable only, cancelled trip and stop, foreign, unknown delay, unknown arrival and departure, explicit arc positions, a line name in UTF-8, no line, no train number, two shapes.",
      decoder: "keyframe",
      expected: sorted(KEYFRAME),
      bytes: keyframe,
    },
    {
      name: "keyframe-empty",
      description: "A keyframe without trips: every table present and empty.",
      decoder: "keyframe",
      expected: { ...KEYFRAME, trips: [] },
      bytes: encodeKeyframe({ ...KEYFRAME, trips: [] }),
    },
    {
      name: "delta-basic",
      description: "A delta from 1000 to 1001: one changed trip, one new trip, two removals.",
      decoder: "delta",
      expected: {
        ...DELTA,
        trips: [...DELTA.trips].sort((a, b) => a.key - b.key),
        removed: [...DELTA.removed].sort((a, b) => a - b),
      },
      bytes: encodeDelta(DELTA),
    },
    {
      name: "head-basic",
      description: "Head at sequence 1001, latest keyframe 1000, deltas kept from 900.",
      decoder: "head",
      expected: HEAD,
      bytes: encodeHead(HEAD),
    },
    {
      name: "head-pack-sets",
      description:
        "head-counts with pack sets (1.4, section 0x62): epoch 3, base set 2,995,000 in 7 parts, increments after 2,994,996.",
      decoder: "head",
      expected: HEAD_PACK_SETS,
      bytes: encodeHead(HEAD_PACK_SETS),
    },
    {
      name: "shape-pack-basic",
      description:
        "Two shapes: one with elevation, three stops and a tunnel; one at the corner of the Web Mercator square without elevation, stops or tunnels.",
      decoder: "shapePack",
      expected: PACK,
      bytes: encodeShapePack(PACK),
    },
    {
      name: "keyframe-shape-numbers",
      description: "keyframe-basic with shapes named by stable numbers (section 0x31).",
      decoder: "keyframe",
      expected: sorted(KEYFRAME_NUMBERED),
      bytes: encodeKeyframe(KEYFRAME_NUMBERED),
    },
    {
      name: "keyframe-vehicle",
      description:
        "keyframe-shape-numbers with each trip's vehicle (1.3, sections 0x1C to 0x1E): series with units, an operator only, nothing known, and a series equal to a line name in one string row.",
      decoder: "keyframe",
      expected: sorted(KEYFRAME_VEHICLE),
      bytes: encodeKeyframe(KEYFRAME_VEHICLE),
    },
    {
      name: "delta-vehicle",
      description:
        "delta-basic with the vehicles of its trips (1.3): one known, one named unknown.",
      decoder: "delta",
      expected: sortedFrame(DELTA_VEHICLE),
      bytes: encodeDelta(DELTA_VEHICLE),
    },
    {
      name: "shape-pack-numbered",
      description: "shape-pack-basic with shape numbers (section 0x76).",
      decoder: "shapePack",
      expected: PACK_NUMBERED,
      bytes: encodeShapePack(PACK_NUMBERED),
    },
    {
      name: "shape-pack-stubs",
      description:
        "shape-pack-numbered with track stubs (version 1.2, sections 0x80 to 0x83): two vertices before and one after the first shape, none on the second.",
      decoder: "shapePack",
      expected: PACK_STUBS,
      bytes: encodeShapePack(PACK_STUBS),
    },
    {
      name: "shape-pack-compact",
      description:
        "shape-pack-stubs in the compact vertex coding (version 1.4, critical sections 0x84 to 0x87): zigzag varints of the x and y steps, of whole centimetre z steps and of each M step less the step predicted from x and y. Decodes to the same shapes.",
      decoder: "shapePack",
      expected: PACK_COMPACT,
      bytes: encodeShapePack(PACK_COMPACT),
    },
    {
      name: "keyframe-future-minor",
      description:
        "keyframe-basic written as version 1.3 with a 48-byte header and two unknown non-critical sections: a 1.0 decoder reads the same trips.",
      decoder: "keyframe",
      expected: sorted(KEYFRAME),
      bytes: futureMinor(keyframe),
    },
    {
      name: "keyframe-limits",
      description:
        "Two trips with every field at the end of its range: keys 0 and 4294967295, shape numbers 0 and 4294967295 under epoch 4294967295, delays -32767 and 32767, start at -timeBase and at 2147483647, run and dwell 65535, firstStop 65535, train number 4294967295, a line of 300 bytes, explicit arc positions 0 and 42949672.95 m, sequence and timetable version 4294967295.",
      decoder: "keyframe",
      expected: sortedFrame(KEYFRAME_LIMITS),
      bytes: encodeKeyframe(KEYFRAME_LIMITS),
    },
    {
      name: "keyframe-unaligned",
      description:
        "keyframe-basic with every section at an odd offset: a valid layout encoders do not write; decoders copy the columns and read the same trips.",
      decoder: "keyframe",
      expected: sortedFrame(KEYFRAME),
      bytes: unaligned(keyframe),
    },
    {
      name: "delta-removal-only",
      description:
        "A delta from 1000 to 1001 without trips that removes three keys, 0 and 4294967295 among them.",
      decoder: "delta",
      expected: sortedFrame(DELTA_REMOVALS),
      bytes: encodeDelta(DELTA_REMOVALS),
    },
    {
      name: "delta-future-section",
      description:
        "delta-basic written as version 1.2 with an unknown non-critical section 0x51: a 1.0 decoder reads the same delta.",
      decoder: "delta",
      expected: sortedFrame(DELTA),
      bytes: extended(encodeDelta(DELTA), [{ id: 0x51, data: u32(7, 8, 9) }], { versionMinor: 2 }),
    },
    {
      name: "invalid-critical-section",
      description: "keyframe-basic as version 1.1 with an unknown critical section.",
      decoder: "keyframe",
      error: "unsupported_version",
      bytes: extended(
        keyframe,
        [{ id: 0x1b, data: Uint8Array.from([1, 2, 3, 4]), critical: true }],
        { versionMinor: 1 },
      ),
    },
    {
      name: "invalid-head-gap",
      description:
        "A head with keyframe 990 and oldest delta 995: deltas 991 to 994 are missing, so no path leads from the keyframe to 1001.",
      decoder: "head",
      error: "corrupt",
      bytes: invalidHead(),
    },
    {
      name: "invalid-delta-base",
      description:
        "delta-basic with baseSequence 999 for sequence 1001 (the base must be sequence - 1).",
      decoder: "delta",
      error: "corrupt",
      bytes: rebuilt(encodeDelta(DELTA), {}, { baseSequence: 999 }),
    },
    {
      name: "invalid-stop-flags",
      description: "keyframe-basic with a stop flagged both arrival unknown and departure unknown.",
      decoder: "keyframe",
      error: "corrupt",
      bytes: invalidStopFlags(keyframe),
    },
    {
      name: "invalid-one-stop",
      description: "keyframe-basic with a trip of one plan stop (a plan needs two).",
      decoder: "keyframe",
      error: "corrupt",
      bytes: rebuilt(keyframe, { [SECTION.tripStopCount]: u16(3, 3, 1, 4) }),
    },
    {
      name: "invalid-shape-epoch",
      description: "keyframe-shape-numbers with shapeEpoch 0 (numbers need an epoch of 1 or more).",
      decoder: "keyframe",
      error: "corrupt",
      bytes: rebuilt(encodeKeyframe(KEYFRAME_NUMBERED), {}, { shapeEpoch: 0 }),
    },
    {
      name: "invalid-pack-arc-length",
      description:
        "shape-pack-basic whose first shape's m column adds up to 1 cm less than its length.",
      decoder: "shapePack",
      error: "corrupt",
      bytes: rebuilt(encodeShapePack(PACK), {
        [SECTION.vertexM]: u32(0, 15_050, 16_189, 0, 50_834),
      }),
    },
    {
      name: "invalid-pack-compact-arc",
      description:
        "shape-pack-basic in the compact coding whose first shape's last M residual is 1 cm smaller, so its M adds up to less than its length.",
      decoder: "shapePack",
      error: "corrupt",
      bytes: invalidCompactArc(),
    },
    {
      name: "invalid-major",
      description: "keyframe-basic with major version 2 and a valid CRC.",
      decoder: "keyframe",
      error: "unsupported_version",
      bytes: resealed(keyframe, (copy) => {
        copy[HEADER.versionMajor] = 2;
      }),
    },
    {
      name: "invalid-magic",
      description: "keyframe-basic with the magic changed to GLFX.",
      decoder: "keyframe",
      error: "bad_magic",
      bytes: resealed(keyframe, (copy) => {
        copy[3] = 0x58;
      }),
    },
    {
      name: "invalid-truncated",
      description: "keyframe-basic without its last 9 bytes.",
      decoder: "keyframe",
      error: "truncated",
      bytes: keyframe.slice(0, keyframe.length - 9),
    },
    {
      name: "invalid-checksum",
      description: "keyframe-basic with one bit of the last byte flipped.",
      decoder: "keyframe",
      error: "checksum",
      bytes: keyframe.map((value, i) => (i === keyframe.length - 1 ? value ^ 1 : value)),
    },
    {
      name: "invalid-repeated-key",
      description: "keyframe-basic with its first trip key set to the second one, valid CRC.",
      decoder: "keyframe",
      error: "corrupt",
      bytes: resealed(keyframe, (copy) => {
        const view = new DataView(copy.buffer);
        view.setUint32(keyOffset, view.getUint32(keyOffset + 4, true), true);
      }),
    },
    {
      name: "invalid-wrong-kind",
      description: "A head given to the keyframe decoder.",
      decoder: "keyframe",
      error: "wrong_kind",
      bytes: encodeHead(HEAD),
    },
    {
      name: "head-counts",
      description:
        "head-basic as version 1.1 with legend counts (section 0x61): running trips in total and for hsr, trips without track geometry in total and for reg and sbahn, cancelled trips 0, realtime trips; decoded in code order.",
      decoder: "head",
      expected: { ...HEAD, counts: countsInCodeOrder() },
      bytes: encodeHead(HEAD_COUNTS),
    },
    {
      name: "head-counts-future",
      description:
        "A 1.1 head whose section 0x61 also holds a metric (code 0x05ff) and a category (code 0x0120) this version does not know: decoders skip those two rows.",
      decoder: "head",
      expected: { ...HEAD, counts: [{ metric: "running", category: null, count: 3012 }] },
      bytes: headWithCounts([0x0120, 9, 0x01ff, 3012, 0x05ff, 77]),
    },
    {
      name: "head-after-switch",
      description:
        "The head right after a timetable switch or a restart: keyframe 500 is the latest state, no delta 500 exists, oldest 501.",
      decoder: "head",
      expected: { ...HEAD, sequence: 500, keyframeSequence: 500, oldestSequence: 501 },
      bytes: encodeHead({ ...HEAD, sequence: 500, keyframeSequence: 500, oldestSequence: 501 }),
    },
    {
      name: "invalid-head-counts-order",
      description: "A 1.1 head whose count codes descend (0x02ff before 0x01ff).",
      decoder: "head",
      error: "corrupt",
      bytes: headWithCounts([0x02ff, 41, 0x01ff, 3012]),
    },
  ];
}

function countsInCodeOrder(): HeadCount[] {
  const code = (count: HeadCount) =>
    (HEAD_METRICS.indexOf(count.metric) + 1) * 256 +
    (count.category === null ? 0xff : CATEGORIES.indexOf(count.category));
  return [...(HEAD_COUNTS.counts ?? [])].sort((a, b) => code(a) - code(b));
}

function headWithCounts(values: number[]): Uint8Array {
  const meta = { ...HEAD, baseSequence: 0, shapeEpoch: 0 };
  return writeContainer(
    "head",
    meta,
    [
      { id: SECTION.head, data: u32(HEAD.keyframeSequence, HEAD.sequence, HEAD.oldestSequence) },
      { id: SECTION.headCounts, data: Uint32Array.from(values) },
    ],
    { versionMinor: 1 },
  );
}
