import {
  ContinuityMeter,
  type ContinuityReport,
  type CrossfadeReason,
  createShape,
  DEFAULT_CONTINUITY,
  MotionFleet,
  type Shape,
} from "@gerlines/geo";
import { type MotionStop, motionPlanOf } from "@gerlines/geo/client-plan";
import { decodeShapePack, type Head, shapePolyline, type TripRecord } from "@gerlines/live-frame";
import { type UTurn, uTurnsOffStop } from "../shapes/packs.ts";
import { FrameClient, type ObjectReader } from "./frame-client.ts";

export type HeadEntry = readonly [number, number, number, number, number];

export interface ContinuityOptions {
  readonly frames: ObjectReader;
  readonly packs: ObjectReader;
  readonly shapeEpoch: number;
  readonly heads: readonly HeadEntry[];
  readonly from: number;
  readonly to: number;
  /** Plan seconds per wall second (10 for the 10x gate). */
  readonly timeScale: number;
  /** Frames per wall second, or "variable" for 24 to 120 fps with ±30 % jitter. */
  readonly fps: number | "variable";
  /** Measure only keys whose hash falls into this share (0 to 1), all when 1. */
  readonly sampleShare: number;
  readonly seed: number;
  /** Measure only these keys and log every frame that adds a jump or a stall (diagnosis). */
  readonly keys?: ReadonlySet<number>;
}

export interface Offender {
  readonly key: number;
  readonly shapeNo: number;
  readonly category: string;
  readonly jumps: number;
  readonly stalls: number;
  readonly maxRatio: number;
  readonly minRatio: number;
}

export interface ContinuityEvent {
  readonly key: number;
  readonly at: number;
  readonly kind: "jump" | "stall";
  readonly s: number;
  readonly v: number;
  readonly targetV: number;
  readonly alpha: number;
  readonly lastUpdateAt: number | null;
  readonly lastCrossfade: string | null;
}

interface Measured {
  readonly key: number;
  readonly slot: number;
  readonly shapeNo: number;
  readonly category: string;
  readonly meter: ContinuityMeter | null;
  swaps: number;
  lastUpdateAt: number | null;
  lastCrossfade: string | null;
  /** Arc range (m) the trip was drawn over. */
  minS: number;
  maxS: number;
}

/** A trip drawn through a U-turn of its shape that is not at a stop. */
export interface UTurnPass {
  readonly key: number;
  readonly shapeNo: number;
  readonly from: number;
  readonly to: number;
}

interface PackShape {
  readonly shape: Shape;
  readonly stops: Float64Array;
  readonly length: number;
  readonly uTurns: readonly UTurn[];
}

type Totals = { -readonly [K in keyof ContinuityReport]: ContinuityReport[K] };

export interface ContinuityResult {
  readonly frames: number;
  readonly trips: number;
  readonly measuredTrips: number;
  readonly updates: number;
  readonly crossfades: Record<CrossfadeReason, number>;
  readonly crossfadesPer1000Updates: Record<CrossfadeReason, number>;
  readonly plansFailed: number;
  readonly continuity: Totals;
  readonly visibleSeconds: number;
  readonly freezeSeconds: number;
  readonly freezeShare: number;
  readonly wallSeconds: number;
  readonly offenders: readonly Offender[];
  readonly events: readonly ContinuityEvent[];
  /** Shapes loaded that carry a U-turn off a stop (`uTurnsOffStop`), and measured trips drawn through one. */
  readonly uTurns: {
    readonly shapes: number;
    readonly passes: number;
    readonly trips: number;
    readonly examples: readonly UTurnPass[];
  };
}

const SUMMED = [
  "frames",
  "hiddenFrames",
  "visiblePairs",
  "judgedPairs",
  "jumps",
  "stalls",
  "backwardSteps",
  "visibleSwaps",
  "overspeedSteps",
  "offTrackFrames",
] as const;
const MAXIMA = ["maxRatio", "maxSpeed", "maxTrackDistance", "maxStep", "maxAcceleration"] as const;

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function sampled(key: number, share: number): boolean {
  if (share >= 1) return true;
  const hash = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return hash / 0x100000000 < share;
}

function emptyReasons(): Record<CrossfadeReason, number> {
  return { start: 0, distance: 0, shape: 0, stop: 0, gap: 0, invalid: 0 };
}

function emptyTotals(): Totals {
  return {
    frames: 0,
    hiddenFrames: 0,
    visiblePairs: 0,
    judgedPairs: 0,
    maxRatio: 0,
    minRatio: Number.POSITIVE_INFINITY,
    jumps: 0,
    stalls: 0,
    backwardSteps: 0,
    visibleSwaps: 0,
    overspeedSteps: 0,
    maxSpeed: 0,
    offTrackFrames: 0,
    maxTrackDistance: 0,
    maxStep: 0,
    maxAcceleration: 0,
  };
}

function headOf(entry: HeadEntry): Head {
  const [timeBase, sequence, keyframeSequence, oldestSequence, timetableVersion] = entry;
  return { kind: "head", sequence, timetableVersion, timeBase, keyframeSequence, oldestSequence };
}

/** Plan stops of a frame trip on its shape (explicit arcs, else the shape's stop list). */
export function stopsOf(trip: TripRecord, shapeStops: ArrayLike<number>): MotionStop[] {
  return trip.stops.map((stop, j) => ({
    s: stop.s ?? (shapeStops[trip.firstStop + j] as number),
    arrival: stop.arrival ?? (stop.departure as number),
    departure: stop.departure ?? (stop.arrival as number),
    cancelled: stop.cancelled,
  }));
}

/**
 * A headless WP-3.3 client: follows the published heads, builds motion plans from the frames and
 * shape packs as the worker will (cancelled stops left out, the category dynamics of
 * `dynamicsFor`), advances a MotionFleet frame by frame at a time scale and measures every drawn
 * frame with ContinuityMeter (design note §5).
 */
class ContinuityRun {
  private readonly options: ContinuityOptions;
  private readonly client: FrameClient;
  private readonly fleet = new MotionFleet();
  private readonly shapes = new Map<number, PackShape | null>();
  private readonly measured = new Map<number, Measured>();
  private readonly totals = emptyTotals();
  private readonly crossfades = emptyReasons();
  private readonly random: () => number;
  private updates = 0;
  private plansFailed = 0;
  private trips = 0;
  private measuredTrips = 0;
  private visibleSeconds = 0;
  private freezeSeconds = 0;
  private readonly offenders: Offender[] = [];
  private readonly events: ContinuityEvent[] = [];
  private uTurnShapes = 0;
  private uTurnPasses = 0;
  private uTurnTrips = 0;
  private readonly uTurnExamples: UTurnPass[] = [];

  constructor(options: ContinuityOptions) {
    this.options = options;
    this.client = new FrameClient(options.frames);
    this.fleet.timeScale = options.timeScale;
    this.random = seeded(options.seed);
  }

  async run(): Promise<ContinuityResult> {
    const started = performance.now();
    const { heads } = this.options;
    let headAt = heads.findIndex((entry) => entry[0] >= this.options.from);
    if (headAt < 0) headAt = heads.length;
    let now = this.options.from;
    let frames = 0;
    while (now < this.options.to) {
      while (headAt < heads.length && (heads[headAt] as HeadEntry)[0] <= now) {
        await this.follow(heads[headAt] as HeadEntry, now);
        headAt++;
      }
      const dt = this.frameStep();
      this.fleet.advance(now);
      frames++;
      this.measureFrame(now, dt);
      now += dt;
    }
    for (const entry of this.measured.values()) this.fold(entry);
    return this.result(frames, performance.now() - started);
  }

  private frameStep(): number {
    const fps = this.options.fps;
    const wall =
      fps === "variable" ? (0.7 + 0.6 * this.random()) / (24 + 96 * this.random()) : 1 / fps;
    return wall * this.options.timeScale;
  }

  private async follow(entry: HeadEntry, now: number): Promise<void> {
    const result = await this.client.follow(headOf(entry));
    for (const key of result.removed) this.remove(key);
    for (const trip of result.changed) await this.apply(trip, now);
  }

  private async shapeOf(number: number): Promise<PackShape | null> {
    if (this.shapes.has(number)) return this.shapes.get(number) ?? null;
    const bytes = await this.options.packs(`s/${this.options.shapeEpoch}/${number}.bin`);
    let entry: PackShape | null = null;
    if (bytes) {
      const polyline = shapePolyline(decodeShapePack(bytes), 0);
      const uTurns = uTurnsOffStop(polyline.x, polyline.y, polyline.s, polyline.stops);
      if (uTurns.length > 0) this.uTurnShapes++;
      entry = {
        shape: createShape(polyline),
        stops: polyline.stops,
        length: polyline.length,
        uTurns,
      };
    }
    this.shapes.set(number, entry);
    return entry;
  }

  private async apply(trip: TripRecord, now: number): Promise<void> {
    const shapeNo = trip.shapeId as number;
    const shape = await this.shapeOf(shapeNo);
    const plan = shape
      ? motionPlanOf(stopsOf(trip, shape.stops), trip.category, shape.length)
      : null;
    if (!shape || !plan) {
      this.plansFailed++;
      this.remove(trip.key);
      return;
    }
    const entry = this.measured.get(trip.key);
    if (!entry) {
      this.add(trip, shapeNo, shape, this.fleet.add(shape.shape, plan, now));
      return;
    }
    this.updates++;
    const sameShape = shapeNo === entry.shapeNo;
    const result = this.fleet.update(entry.slot, plan, now, sameShape ? undefined : shape.shape);
    if (result.crossfade) this.crossfades[result.crossfade]++;
    entry.lastUpdateAt = now;
    entry.lastCrossfade = result.crossfade ?? null;
    if (!sameShape) this.measured.set(trip.key, { ...entry, shapeNo });
  }

  private add(trip: TripRecord, shapeNo: number, shape: PackShape, slot: number): void {
    const key = trip.key;
    this.trips++;
    const keys = this.options.keys;
    const measure = keys ? keys.has(key) : sampled(key, this.options.sampleShare);
    if (measure) this.measuredTrips++;
    this.measured.set(key, {
      key,
      slot,
      shapeNo,
      category: trip.category,
      lastUpdateAt: null,
      lastCrossfade: null,
      minS: Number.POSITIVE_INFINITY,
      maxS: Number.NEGATIVE_INFINITY,
      meter: measure ? new ContinuityMeter(DEFAULT_CONTINUITY, shape.shape) : null,
      swaps: this.fleet.swaps[slot] as number,
    });
  }

  private remove(key: number): void {
    const entry = this.measured.get(key);
    if (!entry) return;
    this.fold(entry);
    this.fleet.remove(entry.slot);
    this.measured.delete(key);
  }

  private measureFrame(now: number, dt: number): void {
    const fleet = this.fleet;
    for (const entry of this.measured.values()) {
      const slot = entry.slot;
      const swaps = fleet.swaps[slot] as number;
      const swapped = swaps !== entry.swaps;
      entry.swaps = swaps;
      if (!entry.meter) continue;
      const alpha = fleet.alpha[slot] as number;
      const x = fleet.x[slot] as number;
      const y = fleet.y[slot] as number;
      const before = this.options.keys ? entry.meter.report() : null;
      entry.meter.observe(now, x, y, alpha, fleet.s[slot] as number, swapped);
      if (before) this.logEvents(entry, before, now);
      if (alpha <= 0) continue;
      const s = fleet.s[slot] as number;
      entry.minS = Math.min(entry.minS, s);
      entry.maxS = Math.max(entry.maxS, s);
      this.visibleSeconds += dt;
      const stopped = (fleet.v[slot] as number) < 0.01 && (fleet.targetV[slot] as number) > 1;
      if (alpha === 1 && stopped) this.freezeSeconds += dt;
    }
  }

  private logEvents(entry: Measured, before: ContinuityReport, now: number): void {
    const after = (entry.meter as ContinuityMeter).report();
    const kind =
      after.jumps > before.jumps ? "jump" : after.stalls > before.stalls ? "stall" : null;
    if (!kind || this.events.length >= 500) return;
    const slot = entry.slot;
    this.events.push({
      key: entry.key,
      at: Math.round(now * 1000) / 1000,
      kind,
      s: Math.round((this.fleet.s[slot] as number) * 100) / 100,
      v: Math.round((this.fleet.v[slot] as number) * 1000) / 1000,
      targetV: Math.round((this.fleet.targetV[slot] as number) * 1000) / 1000,
      alpha: this.fleet.alpha[slot] as number,
      lastUpdateAt: entry.lastUpdateAt,
      lastCrossfade: entry.lastCrossfade,
    });
  }

  private fold(entry: Measured): void {
    if (!entry.meter) return;
    this.foldUTurns(entry);
    const report = entry.meter.report();
    if ((report.jumps > 0 || report.stalls > 0) && this.offenders.length < 200) {
      this.offenders.push({
        key: entry.key,
        shapeNo: entry.shapeNo,
        category: entry.category,
        jumps: report.jumps,
        stalls: report.stalls,
        maxRatio: report.maxRatio,
        minRatio: report.minRatio,
      });
    }
    for (const name of SUMMED) this.totals[name] += report[name];
    for (const name of MAXIMA) this.totals[name] = Math.max(this.totals[name], report[name]);
    if (report.judgedPairs > 0)
      this.totals.minRatio = Math.min(this.totals.minRatio, report.minRatio);
  }

  private foldUTurns(entry: Measured): void {
    const uTurns = this.shapes.get(entry.shapeNo)?.uTurns ?? [];
    let passed = 0;
    for (const turn of uTurns) {
      if (turn.from < entry.minS || turn.to > entry.maxS) continue;
      passed++;
      if (this.uTurnExamples.length < 50) {
        this.uTurnExamples.push({
          key: entry.key,
          shapeNo: entry.shapeNo,
          from: Math.round(turn.from * 100) / 100,
          to: Math.round(turn.to * 100) / 100,
        });
      }
    }
    this.uTurnPasses += passed;
    if (passed > 0) this.uTurnTrips++;
  }

  private result(frames: number, milliseconds: number): ContinuityResult {
    const per1000 = emptyReasons();
    for (const reason of Object.keys(per1000) as CrossfadeReason[]) {
      const share = this.updates > 0 ? this.crossfades[reason] / this.updates : 0;
      per1000[reason] = Math.round(share * 1_000_000) / 1000;
    }
    const minRatio = Number.isFinite(this.totals.minRatio) ? this.totals.minRatio : 1;
    return {
      frames,
      trips: this.trips,
      measuredTrips: this.measuredTrips,
      updates: this.updates,
      crossfades: this.crossfades,
      crossfadesPer1000Updates: per1000,
      plansFailed: this.plansFailed,
      continuity: { ...this.totals, minRatio },
      visibleSeconds: Math.round(this.visibleSeconds),
      freezeSeconds: Math.round(this.freezeSeconds),
      freezeShare: this.visibleSeconds > 0 ? this.freezeSeconds / this.visibleSeconds : 0,
      wallSeconds: Math.round(milliseconds / 100) / 10,
      offenders: this.offenders,
      events: this.events,
      uTurns: {
        shapes: this.uTurnShapes,
        passes: this.uTurnPasses,
        trips: this.uTurnTrips,
        examples: this.uTurnExamples,
      },
    };
  }
}

export function runContinuity(options: ContinuityOptions): Promise<ContinuityResult> {
  return new ContinuityRun(options).run();
}
