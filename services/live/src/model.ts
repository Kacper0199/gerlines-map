import type { Category } from "@gerlines/live-frame";

/** Why a running trip is not drawn (D-038 item 1). */
export type GeometryGap = "low_quality" | "unmeasured" | "no_shape";

/**
 * The shape a pattern runs on: its stable number, content hash, length and stop arcs in metres
 * rounded to centimetres (the precision of the shape pack, so the engine and clients agree).
 */
export interface ShapeInfo {
  readonly shapeNo: number;
  readonly hash: string;
  readonly length: number;
  readonly stopArcs: Float64Array;
  readonly qaStatus: string;
}

/** One timetable trip on one service day (the static half of a trip instance). */
export interface StaticRun {
  readonly instanceId: string;
  readonly serviceDate: string;
  readonly feedVersionId: number;
  readonly tripKey: string;
  readonly category: Category;
  readonly categoryCode: string;
  readonly foreign: boolean;
  readonly line: string | null;
  readonly trainNumber: number | null;
  /** The trip's short name as the feed gives it (the resolver's train number, FORMAT aside). */
  readonly shortName: string | null;
  /** The route's catalogue operator id, null when the feed names none we know. */
  readonly operatorId: string | null;
  readonly patternId: string;
  readonly stopPlaces: readonly string[];
  /**
   * Scheduled arrival and departure per stop in Unix seconds. Plain arrays of small integers: a
   * typed array per run costs several hundred bytes of overhead (about 70,000 runs are held).
   */
  readonly arrivals: ArrayLike<number>;
  readonly departures: ArrayLike<number>;
  /** 1 for a stop where the train neither picks up nor sets down (passes through), else 0. */
  readonly passThrough: ArrayLike<number>;
  readonly shape: ShapeInfo | null;
  readonly gap: GeometryGap | null;
}

/** Live-frame category for a canonical category code; codes the format lacks read as unknown. */
export function frameCategory(code: string): Category {
  switch (code) {
    case "hsr":
    case "ld":
    case "night":
    case "rfast":
    case "reg":
    case "sbahn":
    case "urban":
    case "bus":
      return code;
    default:
      return "unknown";
  }
}

/** Metres rounded to the centimetre, the precision of every arc position in the format. */
export function centimetre(metres: number): number {
  return Math.round(metres * 100) / 100;
}
