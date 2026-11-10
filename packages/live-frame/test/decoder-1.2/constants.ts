export const MAGIC = 0x52464c47;
export const VERSION_MAJOR = 1;
/** The newest minor version this package reads and writes (FORMAT.md section 6). */
export const VERSION_MINOR = 2;
/** Encoders write the lowest minor that holds the content: 1.0 unless an object needs 1.1. */
export const BASE_MINOR = 0;
export const HEADER_LENGTH = 40;
export const DIRECTORY_ENTRY_LENGTH = 12;
export const SECTION_ALIGNMENT = 8;
export const SECTION_CRITICAL = 1;

export const HEADER = {
  magic: 0,
  versionMajor: 4,
  versionMinor: 5,
  kind: 6,
  headerFlags: 7,
  headerLength: 8,
  sectionCount: 10,
  totalLength: 12,
  crc32: 16,
  sequence: 20,
  baseSequence: 24,
  timetableVersion: 28,
  timeBase: 32,
  shapeEpoch: 36,
} as const;

export const KIND_CODES = { keyframe: 1, delta: 2, head: 3, shapePack: 4 } as const;
export type FrameKind = keyof typeof KIND_CODES;

export const SECTION = {
  tripKey: 0x10,
  tripShape: 0x11,
  tripCategory: 0x12,
  tripFlags: 0x13,
  tripDelay: 0x14,
  tripFirstStop: 0x15,
  tripStopCount: 0x16,
  tripStart: 0x17,
  tripLine: 0x18,
  tripTrainNumber: 0x19,
  stopRun: 0x20,
  stopDwell: 0x21,
  stopFlags: 0x22,
  stopArc: 0x23,
  shapeId: 0x30,
  shapeNumber: 0x31,
  stringOffsets: 0x40,
  stringBytes: 0x41,
  removed: 0x50,
  head: 0x60,
  headCounts: 0x61,
  packHash: 0x70,
  packVertexCount: 0x71,
  packStopCount: 0x72,
  packTunnelCount: 0x73,
  packLength: 0x74,
  packFlags: 0x75,
  packNumber: 0x76,
  vertexX: 0x78,
  vertexY: 0x79,
  vertexZ: 0x7a,
  vertexM: 0x7d,
  packStopArc: 0x7b,
  packTunnel: 0x7c,
  stubCount: 0x80,
  stubX: 0x81,
  stubY: 0x82,
  stubDistance: 0x83,
} as const;

export const CATEGORIES = [
  "unknown",
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "urban",
  "bus",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Head count metrics of section 0x61 (FORMAT.md section 4.1), code = index + 1. */
export const HEAD_METRICS = ["running", "untracked", "cancelled", "realtime"] as const;
export type HeadMetric = (typeof HEAD_METRICS)[number];
/** The category byte of a head count code that stands for every category. */
export const ALL_CATEGORIES = 0xff;
export const HEAD_COUNTS_MINOR = 1;
/** The minor version of a shape pack that carries track stubs (FORMAT.md 5.3). */
export const STUB_MINOR = 2;

export const TRIP_FLAG = { realtime: 1, cancelled: 2, foreign: 4, explicitArc: 8 } as const;
export const STOP_FLAG = {
  arrivalUnknown: 1,
  departureUnknown: 2,
  cancelled: 4,
  realtime: 8,
} as const;
export const PACK_FLAG = { elevation: 1 } as const;

export const DELAY_UNKNOWN = -32768;
export const NO_STRING = 0xffff;
export const SHAPE_ID_BYTES = 8;
export const CONTENT_HASH_BYTES = 32;
export const MAX_U16 = 0xffff;
export const MAX_U32 = 0xffffffff;
/** Half the side of the Web Mercator square in centimetres, rounded up. */
export const MERCATOR_LIMIT_CM = 2_003_750_835;
