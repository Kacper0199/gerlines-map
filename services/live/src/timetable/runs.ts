import { normalizeTrainNumber, tripInstanceId } from "@gerlines/schema/ids";
import { serviceInstant } from "@gerlines/schema/service-day";
import {
  centimetre,
  frameCategory,
  type GeometryGap,
  type ShapeInfo,
  type StaticRun,
} from "../model.ts";

/** A trip pattern with its stop places and the shape WP-2.2 linked to it (null when none). */
export interface PatternRow {
  readonly trip_pattern_id: string;
  readonly stop_places: readonly string[];
  readonly shape_no: number | null;
  readonly shape_hash: string | null;
  readonly length_m: number | null;
  /** M of the last vertex: the pack's length, within 1 cm of length_m. */
  readonly end_m: number | null;
  readonly stop_arc_m: readonly number[] | null;
  readonly qa_status: string | null;
}

/** A trip that runs on a service day, with its stop times in stop order. */
export interface TripRow {
  readonly trip_key: string;
  readonly trip_pattern_id: string;
  readonly short_name: string | null;
  readonly category_code: string;
  readonly is_foreign: boolean;
  readonly line: string | null;
  readonly operator_id: string | null;
  readonly arrivals: readonly (number | null)[];
  readonly departures: readonly (number | null)[];
  readonly pickups: readonly number[];
  readonly drop_offs: readonly number[];
}

export interface Pattern {
  readonly stopPlaces: readonly string[];
  readonly shape: ShapeInfo | null;
  readonly gap: GeometryGap | null;
}

const MAX_U32 = 0xffffffff;

/** A shape's length as its pack stores it: the last vertex's M in whole centimetres. */
export function packLength(endM: number): number {
  return centimetre(endM);
}
const NO_SERVICE = 1;

/**
 * One copy of the strings and shapes patterns repeat (stop places, shape stop arcs): pg hands every
 * row fresh strings, and many patterns share a shape (`shape_pattern` has one row per hash).
 */
export class PatternInterner {
  private readonly strings = new Map<string, string>();
  private readonly shapes = new Map<string, ShapeInfo>();

  string(value: string): string {
    const held = this.strings.get(value);
    if (held !== undefined) return held;
    this.strings.set(value, value);
    return value;
  }

  shape(info: ShapeInfo): ShapeInfo {
    const held = this.shapes.get(info.hash);
    if (held) return held;
    this.shapes.set(info.hash, info);
    return info;
  }
}

export function patternOf(row: PatternRow, interner = new PatternInterner()): Pattern {
  const stopPlaces = row.stop_places.map((place) => interner.string(place));
  const stopCount = stopPlaces.length;
  if (
    row.shape_no === null ||
    row.shape_hash === null ||
    row.length_m === null ||
    row.stop_arc_m === null ||
    row.stop_arc_m.length !== stopCount
  ) {
    return { stopPlaces, shape: null, gap: "no_shape" };
  }
  const length = packLength(row.end_m ?? row.length_m);
  const shape = interner.shape({
    shapeNo: row.shape_no,
    hash: row.shape_hash,
    length,
    stopArcs: Float64Array.from(row.stop_arc_m, (arc) => Math.min(centimetre(arc), length)),
    qaStatus: row.qa_status ?? "unmeasured",
  });
  const arcsFall = shape.stopArcs.some(
    (arc, i) => i > 0 && arc < (shape.stopArcs[i - 1] as number),
  );
  const gap: GeometryGap | null = arcsFall
    ? "low_quality"
    : shape.qaStatus === "pass"
      ? null
      : shape.qaStatus === "unmeasured"
        ? "unmeasured"
        : "low_quality";
  return { stopPlaces, shape, gap };
}

/** The frame's train number: a positive integer that fits u32, else none. */
export function frameTrainNumber(shortName: string | null): number | null {
  const normalized = normalizeTrainNumber(shortName);
  if (normalized === null || !/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return value >= 1 && value <= MAX_U32 ? value : null;
}

function timesOf(
  serviceDate: string,
  primary: readonly (number | null)[],
  fallback: readonly (number | null)[],
): number[] {
  return Array.from(primary, (value, i) => {
    const seconds = value ?? fallback[i] ?? 0;
    return serviceInstant(serviceDate, seconds) / 1000;
  });
}

const noPassThrough = new Map<number, readonly number[]>();

/**
 * Pass-through flags per stop: no pickup, no drop-off and no scheduled dwell. A no-service stop
 * with a dwell is an operational halt (a reversal such as RB 20 at Stolberg Hbf, a crew change):
 * the train stands there. Runs without any share one frozen array per stop count.
 */
export function passThroughOf(trip: TripRow): ArrayLike<number> {
  const last = trip.pickups.length - 1;
  const flags = trip.pickups.map((pickup, i) => {
    const arrival = trip.arrivals[i];
    const departure = trip.departures[i];
    const dwell = arrival != null && departure != null && departure > arrival;
    return i > 0 && i < last && pickup === NO_SERVICE && trip.drop_offs[i] === NO_SERVICE && !dwell
      ? 1
      : 0;
  });
  if (flags.includes(1)) return flags;
  let shared = noPassThrough.get(flags.length);
  if (!shared) {
    shared = Object.freeze(flags);
    noPassThrough.set(flags.length, shared);
  }
  return shared;
}

/**
 * One run of a trip on a service day. The instance id is ingest's UUIDv5 (architecture §4): the
 * same service date, operator, normalised train number, origin stop place and origin departure.
 */
export function runOf(
  feedVersionId: number,
  serviceDate: string,
  trip: TripRow,
  pattern: Pattern,
): StaticRun {
  const arrivals = timesOf(serviceDate, trip.arrivals, trip.departures);
  const departures = timesOf(serviceDate, trip.departures, trip.arrivals);
  const instanceId = tripInstanceId({
    serviceDate,
    operatorId: trip.operator_id,
    trainNumber: normalizeTrainNumber(trip.short_name),
    originStopPlaceId: pattern.stopPlaces[0] ?? "",
    originDeparture: (departures[0] as number) * 1000,
  });
  const passThrough = passThroughOf(trip);
  const stopsAgree = pattern.stopPlaces.length === arrivals.length;
  return {
    instanceId,
    serviceDate,
    feedVersionId,
    tripKey: trip.trip_key,
    category: frameCategory(trip.category_code),
    categoryCode: trip.category_code,
    foreign: trip.is_foreign,
    line: trip.line?.trim() ? trip.line.trim() : null,
    trainNumber: frameTrainNumber(trip.short_name),
    shortName: trip.short_name,
    operatorId: trip.operator_id,
    patternId: trip.trip_pattern_id,
    stopPlaces: pattern.stopPlaces,
    arrivals,
    departures,
    passThrough,
    shape: stopsAgree ? pattern.shape : null,
    gap: stopsAgree ? pattern.gap : "no_shape",
  };
}

/**
 * One run per real train: when several timetable trips share an instance id (the same train filed
 * twice), the one with the smallest trip key stands for it, as ingest's `Timetable.canonicalRun`.
 */
export function canonicalRuns(runs: readonly StaticRun[]): StaticRun[] {
  const byInstance = new Map<string, StaticRun>();
  for (const run of runs) {
    const existing = byInstance.get(run.instanceId);
    if (!existing || run.tripKey < existing.tripKey) byInstance.set(run.instanceId, run);
  }
  return [...byInstance.values()].sort((a, b) =>
    a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
  );
}
