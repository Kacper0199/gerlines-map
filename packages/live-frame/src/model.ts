import type { Category, HeadMetric } from "./constants.ts";

/**
 * One plan stop. Times are Unix seconds; one of arrival and departure is always known. `s` is the
 * explicit arc position in metres (centimetre precision) for trips whose stops are not the shape's
 * stop list, else null.
 */
export interface StopRecord {
  readonly arrival: number | null;
  readonly departure: number | null;
  readonly cancelled: boolean;
  readonly realtime: boolean;
  readonly s: number | null;
}

/** The motion plan of one running trip (FORMAT.md section 3). */
export interface TripRecord {
  readonly key: number;
  /**
   * First 8 bytes of the shape's content hash as 16 lowercase hex digits, or the shape's stable
   * number; all trips of one frame use the same form.
   */
  readonly shapeId: string | number;
  readonly category: Category;
  readonly realtime: boolean;
  readonly cancelled: boolean;
  readonly foreign: boolean;
  /** Current delay in seconds, null when unknown. */
  readonly delay: number | null;
  readonly line: string | null;
  readonly trainNumber: number | null;
  /** Index of stops[0] in the shape's stop list. */
  readonly firstStop: number;
  readonly stops: readonly StopRecord[];
  /**
   * The trip's vehicle (FORMAT 1.3): the catalogue series id the vehicle identity resolved (layers
   * L0 to L3), the catalogue operator id and the number of coupled units, each null when unknown.
   * A trip that names any of the three makes the frame carry them for every trip, and a decoder
   * then gives all three for every trip; without them it leaves them out.
   */
  readonly series?: string | null;
  readonly operator?: string | null;
  readonly units?: number | null;
}

/**
 * `shapeEpoch` names the shape number registry (FORMAT.md 2.1): 0 when the frame or pack names
 * shapes by content hash prefix, the registry's epoch (at least 1) when it uses shape numbers.
 */
export interface Keyframe {
  readonly kind: "keyframe";
  readonly sequence: number;
  readonly timetableVersion: number;
  readonly shapeEpoch: number;
  readonly timeBase: number;
  readonly trips: readonly TripRecord[];
}

export interface Delta {
  readonly kind: "delta";
  readonly sequence: number;
  readonly baseSequence: number;
  readonly timetableVersion: number;
  readonly shapeEpoch: number;
  readonly timeBase: number;
  readonly trips: readonly TripRecord[];
  readonly removed: readonly number[];
}

/**
 * One legend count of the head (FORMAT.md section 4.1): a metric for one category, or for every
 * category when `category` is null.
 */
export interface HeadCount {
  readonly metric: HeadMetric;
  readonly category: Category | null;
  readonly count: number;
}

export interface Head {
  readonly kind: "head";
  readonly sequence: number;
  readonly timetableVersion: number;
  readonly timeBase: number;
  readonly keyframeSequence: number;
  readonly oldestSequence: number;
  /** Legend counts (FORMAT 1.1); absent in a 1.0 head, in code order after decoding. */
  readonly counts?: readonly HeadCount[];
  /** The published pack sets (FORMAT 1.4, section 4.2); absent when the engine publishes none. */
  readonly packSets?: PackSets;
}

/**
 * Pack sets of a shape epoch (FORMAT.md 4.2): the base set `latest` in `parts` parts and the
 * increments of every set after `first` up to `latest` are published.
 */
export interface PackSets {
  readonly epoch: number;
  readonly latest: number;
  readonly first: number;
  readonly parts: number;
}

/**
 * One shape of a pack. Coordinates are Web Mercator metres and arc positions metres, both with
 * centimetre precision; z in metres or null without elevation; m the arc length of each vertex
 * (WP-2.2's M: flat WGS84 ground metres from 0, never decreasing, ending at `length`); stops and
 * tunnels ([start, end] spans) in the same arc length.
 */
export interface ShapeRecord {
  /** 32-byte content hash as 64 lowercase hex digits. */
  readonly hash: string;
  /** Stable shape number (FORMAT.md 3.4): set when the pack's shapeEpoch is at least 1, else null. */
  readonly number: number | null;
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly z: readonly number[] | null;
  readonly m: readonly number[];
  readonly length: number;
  readonly stops: readonly number[];
  readonly tunnels: readonly (readonly [number, number])[];
  /** Track beyond the first (`before`) and last (`after`) vertex, null where there is none. */
  readonly stubs?: { readonly before: StubRecord | null; readonly after: StubRecord | null };
}

/**
 * Track beyond a shape end (D-055): the vertices after the shape's end vertex in Web Mercator
 * metres, and `d` each vertex's ground distance in metres from that end vertex along the track
 * (never decreasing, the last above 0). Its height is the end vertex's.
 */
export interface StubRecord {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly d: readonly number[];
}

export interface ShapePack {
  readonly kind: "shapePack";
  readonly timetableVersion: number;
  readonly shapeEpoch: number;
  readonly shapes: readonly ShapeRecord[];
  /** "compact": vertex columns as varints with M predicted from x and y (1.4, FORMAT.md 5.4). */
  readonly coding?: "compact";
  /** Shape numbers the frames name that have no pack (1.4, FORMAT.md 5.5); a pack set only. */
  readonly absent?: readonly number[];
}
