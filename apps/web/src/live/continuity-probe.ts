import { ContinuityMeter, DEFAULT_CONTINUITY, type Shape } from "@gerlines/geo";
import type { ContinuityTotals } from "../motion/protocol.ts";
import type { LiveTrains } from "./live-trains.ts";

interface Measured {
  meter: ContinuityMeter;
  shape: Shape;
  swaps: number;
}

function sampled(key: number, share: number): boolean {
  if (share >= 1) return true;
  const hash = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return hash / 0x100000000 < share;
}

/**
 * The server's continuity metric (`live verify continuity`) on the frames this worker evaluates; the map draws a
 * subset of them, at most half a pixel apart. Every frame, a share of the trains go through ContinuityMeter with their position, opacity
 * and arc length. Counts are the same kinds (jumps, stalls, backward steps, swaps drawn above
 * opacity 0, overspeed, off-track), so a browser run can be put next to the headless one.
 */
export class ContinuityProbe {
  private readonly share: number;
  private readonly measured = new Map<number, Measured>();
  private measuredTrains = 0;
  private frames = 0;
  private judgedPairs = 0;
  private jumps = 0;
  private stalls = 0;
  private backwardSteps = 0;
  private visibleSwaps = 0;
  private overspeedSteps = 0;
  private offTrackFrames = 0;
  private maxRatio = 0;
  private minRatio = Number.POSITIVE_INFINITY;
  private maxSpeed = 0;
  private maxAcceleration = 0;
  private maxTrackDistance = 0;

  constructor(share: number) {
    this.share = share;
  }

  observe(trains: LiveTrains, now: number): void {
    const fleet = trains.fleet;
    const seen = new Set<number>();
    for (const entry of trains.values()) {
      if (!sampled(entry.key, this.share)) continue;
      seen.add(entry.key);
      const slot = entry.slot;
      const shape = fleet.shapeOf(slot);
      let state = this.measured.get(entry.key);
      if (!state || state.shape !== shape) {
        if (state) this.fold(state);
        else this.measuredTrains++;
        state = {
          meter: new ContinuityMeter(DEFAULT_CONTINUITY, shape),
          shape,
          swaps: fleet.swaps[slot] as number,
        };
        this.measured.set(entry.key, state);
      }
      const swaps = fleet.swaps[slot] as number;
      const swapped = swaps !== state.swaps;
      state.swaps = swaps;
      state.meter.observe(
        now,
        fleet.x[slot] as number,
        fleet.y[slot] as number,
        fleet.alpha[slot] as number,
        fleet.s[slot] as number,
        swapped,
      );
    }
    for (const [key, state] of this.measured) {
      if (seen.has(key)) continue;
      this.fold(state);
      this.measured.delete(key);
    }
  }

  report(): ContinuityTotals {
    const live = new ContinuityProbe(this.share);
    live.copyFrom(this);
    for (const state of this.measured.values()) live.fold(state);
    return live.totals();
  }

  private copyFrom(other: ContinuityProbe): void {
    this.measuredTrains = other.measuredTrains;
    this.frames = other.frames;
    this.judgedPairs = other.judgedPairs;
    this.jumps = other.jumps;
    this.stalls = other.stalls;
    this.backwardSteps = other.backwardSteps;
    this.visibleSwaps = other.visibleSwaps;
    this.overspeedSteps = other.overspeedSteps;
    this.offTrackFrames = other.offTrackFrames;
    this.maxRatio = other.maxRatio;
    this.minRatio = other.minRatio;
    this.maxSpeed = other.maxSpeed;
    this.maxAcceleration = other.maxAcceleration;
    this.maxTrackDistance = other.maxTrackDistance;
  }

  private fold(state: Measured): void {
    const report = state.meter.report();
    this.frames += report.frames;
    this.judgedPairs += report.judgedPairs;
    this.jumps += report.jumps;
    this.stalls += report.stalls;
    this.backwardSteps += report.backwardSteps;
    this.visibleSwaps += report.visibleSwaps;
    this.overspeedSteps += report.overspeedSteps;
    this.offTrackFrames += report.offTrackFrames;
    this.maxRatio = Math.max(this.maxRatio, report.maxRatio);
    if (report.judgedPairs > 0) this.minRatio = Math.min(this.minRatio, report.minRatio);
    this.maxSpeed = Math.max(this.maxSpeed, report.maxSpeed);
    this.maxAcceleration = Math.max(this.maxAcceleration, report.maxAcceleration);
    this.maxTrackDistance = Math.max(this.maxTrackDistance, report.maxTrackDistance);
  }

  private totals(): ContinuityTotals {
    return {
      measuredTrains: this.measuredTrains,
      frames: this.frames,
      judgedPairs: this.judgedPairs,
      jumps: this.jumps,
      stalls: this.stalls,
      backwardSteps: this.backwardSteps,
      visibleSwaps: this.visibleSwaps,
      overspeedSteps: this.overspeedSteps,
      offTrackFrames: this.offTrackFrames,
      maxRatio: this.maxRatio,
      minRatio: Number.isFinite(this.minRatio) ? this.minRatio : 1,
      maxSpeed: this.maxSpeed,
      maxAcceleration: this.maxAcceleration,
      maxTrackDistance: this.maxTrackDistance,
    };
  }
}
