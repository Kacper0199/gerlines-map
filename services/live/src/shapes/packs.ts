import type { DB } from "@gerlines/db";
import { lonLatToMercator } from "@gerlines/geo";
import {
  decodeShapePack,
  encodeShapePack,
  type ShapeRecord,
  type StubRecord,
} from "@gerlines/live-frame";
import { type Kysely, sql } from "kysely";
import { timed } from "../metrics.ts";
import { centimetre } from "../model.ts";
import type { FileStore } from "../publish/storage.ts";
import { packLength } from "../timetable/runs.ts";

/** The registry epoch of shape numbers (migration 0050, FORMAT.md 3.4). */
export async function currentShapeEpoch(db: Kysely<DB>): Promise<number> {
  const result = await sql<{
    epoch: number | null;
  }>`SELECT max(epoch) AS epoch FROM shape_registry`.execute(db);
  const epoch = result.rows[0]?.epoch;
  if (!epoch) throw new Error("shape_registry holds no epoch (migration 0050 not applied?)");
  return epoch;
}

export interface ShapeRow {
  readonly shape_no: number;
  readonly shape_hash: string;
  readonly elevation_source: string | null;
  readonly tunnel_spans: readonly number[];
  readonly stop_arc_m: readonly number[];
  /** [lon, lat, z, m] per vertex. */
  readonly points: readonly (readonly number[])[];
  /** Track stubs of `shape_stub` (migration 0065): [lon, lat, z, distance from the end vertex]. */
  readonly stubs?: readonly StubRow[] | null;
}

export interface StubRow {
  readonly side: "before" | "after";
  readonly points: readonly (readonly number[])[];
}

/** A stub may start this far (m) from its shape's end vertex. */
export const STUB_START_TOLERANCE_M = 1;
/** The longest stub the pipeline writes (m), plus rounding. */
export const STUB_MAX_M = 400.5;
/** The first stub point beyond STUB_START_TOLERANCE_M must lie within this angle (degrees) of the outward heading. */
export const STUB_START_DEGREES = 30;
const STUB_START_COS = Math.cos((STUB_START_DEGREES * Math.PI) / 180);
/** A stub vertex turning more than this (degrees) between segments of at least 1 m is refused. */
export const STUB_TURN_DEGREES = 90;
const STUB_TURN_COS = Math.cos((STUB_TURN_DEGREES * Math.PI) / 180);
const EARTH_RADIUS_M = 6_371_008.8;

function groundOffset(from: readonly number[], to: readonly number[]): [number, number] {
  const lat = (((from[1] as number) + (to[1] as number)) / 2) * (Math.PI / 180);
  return [
    ((to[0] as number) - (from[0] as number)) * (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(lat),
    ((to[1] as number) - (from[1] as number)) * (Math.PI / 180) * EARTH_RADIUS_M,
  ];
}

/** The vertex at least `metres` of M away from the end, or the far end of a shorter line. */
function pointInside(points: readonly (readonly number[])[], fromEnd: boolean, metres: number) {
  const ordered = fromEnd ? [...points].reverse() : points;
  const start = ordered[0]?.[3] ?? 0;
  return (
    ordered.find((p) => Math.abs((p[3] as number) - start) >= metres) ??
    (ordered.at(-1) as number[])
  );
}

function turnsBack(points: readonly (readonly number[])[]): boolean {
  let previous: [number, number] | null = null;
  let anchor = points[0] as readonly number[];
  for (const point of points.slice(1)) {
    const segment = groundOffset(anchor, point);
    const n = Math.hypot(...segment);
    if (n < 1) continue;
    if (previous) {
      const dot = previous[0] * segment[0] + previous[1] * segment[1];
      if (dot / (Math.hypot(...previous) * n) < STUB_TURN_COS) return true;
    }
    previous = segment;
    anchor = point;
  }
  return false;
}

/** Whether the stub's first point beyond the start tolerance lies off the outward heading. */
function jumpsOff(
  end: readonly number[],
  points: readonly (readonly number[])[],
  heading: readonly [number, number],
): boolean {
  const norm = Math.hypot(...heading);
  if (norm === 0) return false;
  for (const point of points.slice(1)) {
    const [x, y] = groundOffset(end, point);
    const n = Math.hypot(x, y);
    if (n > STUB_START_TOLERANCE_M) {
      return (x * heading[0] + y * heading[1]) / (n * norm) < STUB_START_COS;
    }
  }
  return false;
}

function distanceProblem(points: readonly (readonly number[])[]): "distance" | "length" | null {
  for (let i = 1; i < points.length; i++) {
    if ((points[i]?.[3] as number) < (points[i - 1]?.[3] as number)) return "distance";
  }
  const length = points.at(-1)?.[3] as number;
  return length > 0 && length <= STUB_MAX_M ? null : "length";
}

/**
 * Why a stub cannot go into the pack, or null: it must start at its end vertex, run outward (not
 * back along the shape), leave the end vertex along the outward heading (no sideways or backward
 * jump onto a track), keep its distance growing up to STUB_MAX_M and never turn back.
 */
export function stubProblem(
  shape: readonly (readonly number[])[],
  stub: StubRow,
): "start" | "distance" | "length" | "jump" | "backwards" | "hairpin" | null {
  const after = stub.side === "after";
  const end = (after ? shape.at(-1) : shape[0]) as readonly number[];
  const points = stub.points;
  if (points.length < 2) return "length";
  const start = Math.hypot(...groundOffset(end, points[0] as number[]));
  if (start > STUB_START_TOLERANCE_M) return "start";
  const distance = distanceProblem(points);
  if (distance) return distance;
  const [hx, hy] = groundOffset(pointInside(shape, after, 20), end);
  const [sx, sy] = groundOffset(end, pointInside(points, false, 10));
  if (hx * sx + hy * sy <= 0) return "backwards";
  if (jumpsOff(end, points, [hx, hy])) return "jump";
  return turnsBack(points) ? "hairpin" : null;
}

function stubRecord(stub: StubRow): StubRecord {
  const rest = stub.points.slice(1);
  const mercator = rest.map(([lon = 0, lat = 0]) => lonLatToMercator(lon, lat));
  return {
    x: mercator.map((point) => point.x),
    y: mercator.map((point) => point.y),
    d: rest.map((point) => point[3] as number),
  };
}

function stubsOf(row: ShapeRow): { stubs: ShapeRecord["stubs"]; dropped: string[] } {
  const dropped: string[] = [];
  const found = { before: null as StubRecord | null, after: null as StubRecord | null };
  for (const stub of row.stubs ?? []) {
    const problem = stubProblem(row.points, stub);
    if (problem) dropped.push(`${stub.side} ${problem}`);
    else found[stub.side] = stubRecord(stub);
  }
  return { stubs: found.before || found.after ? found : undefined, dropped };
}

/** A vertex turning more than this (degrees) is a hairpin: the line runs out and back. */
export const HAIRPIN_DEGREES = 160;
const HAIRPIN_COS = Math.cos((HAIRPIN_DEGREES * Math.PI) / 180);

/** A turn this close (m) to an intermediate stop arc is a reversal at the stop, not a spur. */
export const STOP_TURN_TOLERANCE_M = 0.01;

/** A direction change above this (degrees) within U_TURN_WINDOW_M of arc is a U-turn. */
export const U_TURN_DEGREES = 150;
/** Arc (m) between the end of one segment and the start of a later one that a U-turn may span. */
export const U_TURN_WINDOW_M = 60;
const U_TURN_COS = Math.cos((U_TURN_DEGREES * Math.PI) / 180);

/** Arc span [from, to] (m) of a U-turn: the line reverses direction within it. */
export interface UTurn {
  readonly from: number;
  readonly to: number;
}

/** A stop this close (m) to the turning part of a U-turn makes it a reversal at the stop. */
export const U_TURN_STOP_TOLERANCE_M = 5;

/**
 * U-turns not at an intermediate stop: a segment and a later one at most U_TURN_WINDOW_M of arc
 * further whose directions differ by more than U_TURN_DEGREES, however many vertices the turn is
 * spread over (a single-vertex test misses two 90° corners a few metres apart). Overlapping spans
 * merge. The reported span runs from the start of the first segment to the end of the reversing
 * one; only its turning part (end of the first segment to start of the reversing one) is checked
 * for an intermediate stop, so a stop along a long approach does not hide the turn.
 */
export function uTurnsOffStop(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  s: ArrayLike<number>,
  stopArcs: ArrayLike<number> = [],
): UTurn[] {
  const inner = Array.from(stopArcs).slice(1, -1);
  const found: { span: UTurn; turn: UTurn }[] = [];
  const n = x.length;
  for (let i = 0; i + 1 < n; i++) {
    const ax = (x[i + 1] as number) - (x[i] as number);
    const ay = (y[i + 1] as number) - (y[i] as number);
    const la = Math.hypot(ax, ay);
    if (la === 0) continue;
    const end = s[i + 1] as number;
    for (let j = i + 1; j + 1 < n && (s[j] as number) - end <= U_TURN_WINDOW_M; j++) {
      const bx = (x[j + 1] as number) - (x[j] as number);
      const by = (y[j + 1] as number) - (y[j] as number);
      const lb = Math.hypot(bx, by);
      if (lb === 0 || (ax * bx + ay * by) / (la * lb) >= U_TURN_COS) continue;
      const span = { from: s[i] as number, to: s[j + 1] as number };
      const turn = { from: end, to: s[j] as number };
      const last = found[found.length - 1];
      if (last && span.from <= last.span.to) {
        last.span = { from: last.span.from, to: Math.max(last.span.to, span.to) };
        last.turn = {
          from: Math.min(last.turn.from, turn.from),
          to: Math.max(last.turn.to, turn.to),
        };
      } else {
        found.push({ span, turn });
      }
      break;
    }
  }
  return found
    .filter(
      ({ turn }) =>
        !inner.some(
          (arc) =>
            arc >= turn.from - U_TURN_STOP_TOLERANCE_M && arc <= turn.to + U_TURN_STOP_TOLERANCE_M,
        ),
    )
    .map(({ span }) => span);
}

/** Geometry faults of one shape that the pack would otherwise carry silently. */
export interface ShapeFaults {
  /** Vertices turning more than HAIRPIN_DEGREES between their two neighbours. */
  readonly turns: number;
  /** Those turns not at an intermediate stop (a train would run out and back between stops). */
  readonly hairpins: number;
  /** Vertices whose M is below the M before them (flattened in the pack). */
  readonly fallingM: number;
  /** Arc length (m) of the first hairpin not at a stop, null when there is none. */
  readonly firstHairpinAt: number | null;
  /** U-turns not at a stop (`uTurnsOffStop`), single-vertex hairpins among them. */
  readonly uTurns: number;
  /** Arc length (m) where the first such U-turn starts, null when there is none. */
  readonly firstUTurnAt: number | null;
}

/**
 * Turns above 160 degrees (zero-length segments skipped), the ones of them that are not within
 * STOP_TURN_TOLERANCE_M of an intermediate stop arc (hairpins), and falling M of a polyline.
 */
export function shapeFaults(
  x: readonly number[],
  y: readonly number[],
  m: readonly number[],
  stopArcs: readonly number[] = [],
): ShapeFaults {
  const inner = stopArcs.slice(1, -1);
  let turns = 0;
  let hairpins = 0;
  let firstHairpinAt: number | null = null;
  for (let i = 1; i + 1 < x.length; i++) {
    const ax = (x[i] as number) - (x[i - 1] as number);
    const ay = (y[i] as number) - (y[i - 1] as number);
    const bx = (x[i + 1] as number) - (x[i] as number);
    const by = (y[i + 1] as number) - (y[i] as number);
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    if ((ax * bx + ay * by) / (la * lb) >= HAIRPIN_COS) continue;
    turns++;
    const at = m[i] as number;
    if (inner.some((arc) => Math.abs(arc - at) <= STOP_TURN_TOLERANCE_M)) continue;
    hairpins++;
    firstHairpinAt ??= at;
  }
  let fallingM = 0;
  for (let i = 1; i < m.length; i++) if ((m[i] as number) < (m[i - 1] as number)) fallingM++;
  const uTurns = uTurnsOffStop(x, y, m, stopArcs);
  return {
    turns,
    hairpins,
    fallingM,
    firstHairpinAt,
    uTurns: uTurns.length,
    firstUTurnAt: uTurns[0]?.from ?? null,
  };
}

/**
 * One shape as a pack record: Web Mercator metres, elevation when baked, the pipeline's M as arc
 * length (centimetres, never decreasing, ending at the length), stop arcs clamped to the length,
 * tunnel spans that are well formed (others dropped and counted by the caller).
 */
export function shapeRecordOf(row: ShapeRow): {
  record: ShapeRecord;
  droppedTunnels: number;
  faults: ShapeFaults;
  droppedStubs: string[];
} {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  const m: number[] = [];
  const rawM: number[] = [];
  let previous = 0;
  for (const [lon = 0, lat = 0, height = 0, arc = 0] of row.points) {
    const point = lonLatToMercator(lon, lat);
    x.push(point.x);
    y.push(point.y);
    z.push(Number.isFinite(height) ? height : 0);
    rawM.push(arc);
    previous = Math.max(previous, centimetre(arc));
    m.push(m.length === 0 ? 0 : previous);
  }
  const faults = shapeFaults(x, y, rawM, row.stop_arc_m);
  const length = packLength(m.at(-1) ?? 0);
  const stops = row.stop_arc_m.map((arc) => Math.min(centimetre(arc), length));
  const tunnels: [number, number][] = [];
  let droppedTunnels = 0;
  let end = 0;
  for (let i = 0; i + 1 < row.tunnel_spans.length; i += 2) {
    const start = centimetre(row.tunnel_spans[i] as number);
    const stop = Math.min(centimetre(row.tunnel_spans[i + 1] as number), length);
    if (start < stop && start >= end) {
      tunnels.push([start, stop]);
      end = stop;
    } else {
      droppedTunnels++;
    }
  }
  const { stubs, dropped } = stubsOf(row);
  return {
    record: {
      hash: row.shape_hash,
      number: row.shape_no,
      x,
      y,
      z: row.elevation_source ? z : null,
      m,
      length,
      stops,
      tunnels,
      ...(stubs ? { stubs } : {}),
    },
    droppedTunnels,
    faults,
    droppedStubs: dropped,
  };
}

export interface PackBuildReport {
  epoch: number;
  shapes: number;
  written: number;
  unchanged: number;
  failed: number;
  droppedTunnels: number;
  /** Shapes whose pack carries a stub, and stubs left out by `stubProblem` per side and reason. */
  stubShapes: number;
  droppedStubs: Record<string, number>;
  /** Held packs of the same hash with other bytes (stubs added to a published epoch). */
  stale: number;
  plainBytes: number;
  brBytes: number;
  gzBytes: number;
  seconds: number;
  failures: string[];
  /** A full build of more than 0 shapes without failures that passed its gate (marked complete). */
  complete: boolean;
  readonly geometry: GeometryReport;
}

/** Shape numbers the gate accepts per fault, named one by one (never a bare count). */
export interface GateAllowance {
  readonly hairpinShapes?: readonly number[];
  readonly fallingMShapes?: readonly number[];
  readonly uTurnShapes?: readonly number[];
}

/** Hairpins and falling M over every shape read, with the worst offenders and the gate. */
export interface GeometryReport {
  /** Turns above 160 degrees, at stops or not. */
  turns: number;
  /** Turns above 160 degrees not at an intermediate stop. */
  hairpins: number;
  hairpinShapes: number;
  fallingM: number;
  fallingMShapes: number;
  /** U-turns within U_TURN_WINDOW_M not at an intermediate stop, and the shapes carrying them. */
  uTurns: number;
  uTurnShapes: number;
  /**
   * Shapes with a fault, most hairpins first (at most 50):
   * [shape_no, hairpins, fallingM, firstHairpinAt, uTurns, firstUTurnAt].
   */
  offenders: [number, number, number, number | null, number, number | null][];
  readonly allowedHairpinShapes: readonly number[];
  readonly allowedUTurnShapes: readonly number[];
  readonly allowedFallingMShapes: readonly number[];
  /** Shapes with a fault their allowance does not name (the first 50 by number), and their count. */
  refused: number[];
  refusedShapes: number;
  /** Per fault, allowed shapes that did not show that fault (allowances to drop). */
  allowedUnused: { hairpinShapes: number[]; fallingMShapes: number[]; uTurnShapes: number[] };
  passed: boolean;
}

/**
 * Comma lists of shape numbers from the command line, one per repeated option, merged without
 * repeats; only positive decimal integers (`0x10` or `1e5` would name another shape).
 */
export function parseShapeNumbers(value: string | readonly string[] | undefined): number[] {
  const parts = (typeof value === "string" ? [value] : (value ?? []))
    .filter((list) => list.trim() !== "")
    .flatMap((list) => list.split(","));
  const numbers = parts.map((part) => {
    const text = part.trim();
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
      throw new Error(`not a shape number: "${part}"`);
    return Number(text);
  });
  return [...new Set(numbers)];
}

export function newGeometryReport(allow: GateAllowance = {}): GeometryReport {
  return {
    turns: 0,
    hairpins: 0,
    hairpinShapes: 0,
    fallingM: 0,
    fallingMShapes: 0,
    uTurns: 0,
    uTurnShapes: 0,
    offenders: [],
    allowedHairpinShapes: [...(allow.hairpinShapes ?? [])],
    allowedUTurnShapes: [...(allow.uTurnShapes ?? [])],
    allowedFallingMShapes: [...(allow.fallingMShapes ?? [])],
    refused: [],
    refusedShapes: 0,
    allowedUnused: {
      hairpinShapes: [...new Set(allow.hairpinShapes ?? [])],
      fallingMShapes: [...new Set(allow.fallingMShapes ?? [])],
      uTurnShapes: [...new Set(allow.uTurnShapes ?? [])],
    },
    passed: true,
  };
}

const MAX_OFFENDERS = 50;

function useAllowances(
  unused: GeometryReport["allowedUnused"],
  shapeNo: number,
  faults: ShapeFaults,
): void {
  const other = (n: number) => n !== shapeNo;
  if (faults.hairpins > 0) unused.hairpinShapes = unused.hairpinShapes.filter(other);
  if (faults.fallingM > 0) unused.fallingMShapes = unused.fallingMShapes.filter(other);
  if (faults.uTurns > 0) unused.uTurnShapes = unused.uTurnShapes.filter(other);
}

/** Adds one shape's faults; a fault on a shape the allowance does not name for it is refused. */
export function noteFaults(geometry: GeometryReport, shapeNo: number, faults: ShapeFaults): void {
  geometry.turns += faults.turns;
  if (faults.hairpins === 0 && faults.fallingM === 0 && faults.uTurns === 0) return;
  geometry.hairpins += faults.hairpins;
  geometry.fallingM += faults.fallingM;
  geometry.uTurns += faults.uTurns;
  if (faults.hairpins > 0) geometry.hairpinShapes++;
  if (faults.fallingM > 0) geometry.fallingMShapes++;
  if (faults.uTurns > 0) geometry.uTurnShapes++;
  useAllowances(geometry.allowedUnused, shapeNo, faults);
  const refused =
    (faults.hairpins > 0 && !geometry.allowedHairpinShapes.includes(shapeNo)) ||
    (faults.fallingM > 0 && !geometry.allowedFallingMShapes.includes(shapeNo)) ||
    (faults.uTurns > 0 && !geometry.allowedUTurnShapes.includes(shapeNo));
  if (refused) {
    geometry.refusedShapes++;
    geometry.refused.push(shapeNo);
    geometry.refused.sort((a, b) => a - b);
    if (geometry.refused.length > MAX_OFFENDERS) geometry.refused.pop();
  }
  geometry.offenders.push([
    shapeNo,
    faults.hairpins,
    faults.fallingM,
    faults.firstHairpinAt,
    faults.uTurns,
    faults.firstUTurnAt,
  ]);
  geometry.offenders.sort((a, b) => b[1] - a[1] || b[4] - a[4] || b[2] - a[2] || a[0] - b[0]);
  if (geometry.offenders.length > MAX_OFFENDERS) geometry.offenders.pop();
}

/** The gate: passed when no shape carries a fault its allowance does not name. */
export function closeGate(geometry: GeometryReport): GeometryReport {
  geometry.passed = geometry.refusedShapes === 0;
  return geometry;
}

const BATCH = 100;

/**
 * Builds one pack per drawable shape (`qa_status = pass`) the timetable version links to, at
 * `s/<epoch>/<number>.bin`, ahead of time (brotli 11 is slow), and reports hairpins, U-turns and
 * falling M per shape; the geometry gate fails when a shape carries a fault its allowance does not
 * name. A held pack with the same content is kept, also when its header names an earlier timetable
 * version (the packs of an epoch serve every version); a held pack with other content counts as
 * stale; a number that now names another hash stops the build (FORMAT.md 3.4: a number names one
 * hash per epoch).
 */
export async function buildPacks(
  db: Kysely<DB>,
  store: FileStore,
  options: {
    readonly timetableVersion: number;
    readonly limit?: number;
    readonly concurrency?: number;
    /** Shapes the gate accepts with a fault, by number (none unless set). */
    readonly allow?: GateAllowance;
    /** Where shapes and their links are read (default `db`, which always holds the epoch). */
    readonly shapesDb?: Kysely<DB>;
  },
): Promise<PackBuildReport> {
  const started = performance.now();
  const epoch = await currentShapeEpoch(db);
  if (options.limit === undefined) await store.clearPacksComplete(epoch, options.timetableVersion);
  const report: PackBuildReport = {
    epoch,
    shapes: 0,
    written: 0,
    unchanged: 0,
    failed: 0,
    droppedTunnels: 0,
    stubShapes: 0,
    droppedStubs: {},
    stale: 0,
    plainBytes: 0,
    brBytes: 0,
    gzBytes: 0,
    seconds: 0,
    failures: [],
    complete: false,
    geometry: newGeometryReport(options.allow),
  };
  let after = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const shapes = options.shapesDb ?? db;
  const stubTable = await sql<{
    found: boolean;
  }>`SELECT to_regclass('shape_stub') IS NOT NULL AS found`.execute(shapes);
  const stubs = stubTable.rows[0]?.found
    ? sql`ARRAY(SELECT json_build_object('side', st.side, 'points',
                  ARRAY(SELECT ARRAY[ST_X(p.geom), ST_Y(p.geom), ST_Z(p.geom), ST_M(p.geom)]
                          FROM ST_DumpPoints(st.geom) p ORDER BY p.path[1]))
                FROM shape_stub st WHERE st.shape_no = s.shape_no ORDER BY st.side)`
    : sql`NULL`;
  while (report.shapes < limit) {
    const rows = await timed("shape_batch", () =>
      sql<ShapeRow>`
        SELECT s.shape_no, s.shape_hash, s.elevation_source, s.tunnel_spans, s.stop_arc_m,
               ARRAY(SELECT ARRAY[ST_X(d.geom), ST_Y(d.geom), ST_Z(d.geom), ST_M(d.geom)]
                       FROM ST_DumpPoints(s.geom) d ORDER BY d.path[1]) AS points,
               ${stubs} AS stubs
          FROM shape_pattern s
         WHERE s.qa_status = 'pass' AND s.shape_no > ${after}
           AND EXISTS (SELECT 1 FROM trip_pattern_shape link
                        WHERE link.shape_hash = s.shape_hash
                          AND link.feed_version_id = ${options.timetableVersion})
         ORDER BY s.shape_no
         LIMIT ${Math.min(BATCH, limit - report.shapes)}`.execute(shapes),
    );
    if (rows.rows.length === 0) break;
    after = rows.rows.at(-1)?.shape_no ?? after;
    const concurrency = options.concurrency ?? 4;
    for (let i = 0; i < rows.rows.length; i += concurrency) {
      await Promise.all(
        rows.rows
          .slice(i, i + concurrency)
          .map((row) => packOne(row, store, epoch, options, report)),
      );
    }
  }
  closeGate(report.geometry);
  report.seconds = Math.round((performance.now() - started) / 100) / 10;
  if (report.shapes === 0)
    report.failures.push(
      `no drawable shape is linked to timetable version ${options.timetableVersion}`,
    );
  report.complete =
    options.limit === undefined &&
    report.shapes > 0 &&
    report.failed === 0 &&
    report.stale === 0 &&
    report.geometry.passed;
  if (report.complete) {
    await store.markPacksComplete(epoch, options.timetableVersion, {
      shapes: report.shapes,
      allowed: {
        hairpinShapes: report.geometry.allowedHairpinShapes,
        fallingMShapes: report.geometry.allowedFallingMShapes,
        uTurnShapes: report.geometry.allowedUTurnShapes,
      },
    });
  }
  return report;
}

function noteStubs(report: PackBuildReport, record: ShapeRecord, dropped: readonly string[]): void {
  if (record.stubs) report.stubShapes++;
  for (const reason of dropped) {
    report.droppedStubs[reason] = (report.droppedStubs[reason] ?? 0) + 1;
  }
}

async function packOne(
  row: ShapeRow,
  store: FileStore,
  epoch: number,
  options: { readonly timetableVersion: number },
  report: PackBuildReport,
): Promise<void> {
  report.shapes++;
  try {
    const { record, droppedTunnels, faults, droppedStubs } = shapeRecordOf(row);
    report.droppedTunnels += droppedTunnels;
    noteStubs(report, record, droppedStubs);
    noteFaults(report.geometry, row.shape_no, faults);
    const packOf = (timetableVersion: number) =>
      encodeShapePack({ kind: "shapePack", timetableVersion, shapeEpoch: epoch, shapes: [record] });
    const bytes = packOf(options.timetableVersion);
    const held = await store.read(`s/${epoch}/${row.shape_no}.bin`);
    if (held) {
      const heldView = decodeShapePack(held);
      const heldHash = Buffer.from(heldView.hash.subarray(0, 32)).toString("hex");
      if (heldHash !== row.shape_hash) {
        throw new Error(
          `shape number ${row.shape_no} of epoch ${epoch} names ${heldHash}, now ${row.shape_hash}: refusing to publish`,
        );
      }
      const sameContent = packOf(heldView.header.timetableVersion);
      if (!Buffer.from(held).equals(Buffer.from(sameContent))) {
        report.stale++;
        throw new Error(
          `shape number ${row.shape_no} of epoch ${epoch} is published with other bytes (stubs or format changed): register a new shape epoch`,
        );
      }
      report.unchanged++;
      return;
    }
    const sizes = await store.pack(epoch, row.shape_no, bytes);
    if (sizes) {
      report.written++;
      report.plainBytes += sizes.plain;
      report.brBytes += sizes.br;
      report.gzBytes += sizes.gz;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing to publish")) throw error;
    report.failed++;
    if (report.failures.length < 20) {
      report.failures.push(
        `${row.shape_no}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
