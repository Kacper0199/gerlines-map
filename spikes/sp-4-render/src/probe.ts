import { DrawCounter } from "./draws.ts";
import { round, type Summary, summarize } from "./stats.ts";

export interface ProbeResult {
  windowMs: number;
  frames: number;
  fps: number;
  mapDraws: number;
  mapDrawsPerSecond: number;
  frameMs: Summary;
  framesOver20Ms: number;
  framesOver34Ms: number;
  framesOver50Ms: number;
  longTasks: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  byZoom: ZoneFrames[];
}

export interface ZoneFrames {
  zoomFrom: number;
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over34: number;
}

const ZONE_WIDTH = 0.5;

const MAX_FRAMES = 40000;

export class FrameProbe {
  private deltas = new Float64Array(MAX_FRAMES);
  private zooms = new Float32Array(MAX_FRAMES);
  private readonly zoomOf: () => number;
  private frames = 0;
  private lastTimestamp = Number.NaN;
  private startedAt = 0;
  private running = false;
  private longTaskDurations: number[] = [];
  private observer: PerformanceObserver | null = null;
  private readonly draws = new DrawCounter();

  constructor(zoomOf: () => number) {
    this.zoomOf = zoomOf;
  }

  private readonly tick = (timestamp: number): void => {
    if (!this.running) return;
    if (!Number.isNaN(this.lastTimestamp) && this.frames < MAX_FRAMES) {
      this.zooms[this.frames] = this.zoomOf();
      this.deltas[this.frames++] = timestamp - this.lastTimestamp;
    }
    this.lastTimestamp = timestamp;
    requestAnimationFrame(this.tick);
  };

  start(): void {
    this.frames = 0;
    this.lastTimestamp = Number.NaN;
    this.longTaskDurations = [];
    this.startedAt = performance.now();
    this.draws.start(this.startedAt);
    this.running = true;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.longTaskDurations.push(entry.duration);
      });
      this.observer.observe({ type: "longtask" });
    } catch {
      this.observer = null;
    }
    requestAnimationFrame(this.tick);
  }

  noteMapDraw(): void {
    this.draws.note();
  }

  stop(): ProbeResult {
    this.running = false;
    const stoppedAt = performance.now();
    const windowMs = stoppedAt - this.startedAt;
    const draws = this.draws.stop(stoppedAt);
    this.observer?.takeRecords().forEach((entry) => {
      this.longTaskDurations.push(entry.duration);
    });
    this.observer?.disconnect();
    const frameMs = summarize(this.deltas.subarray(0, this.frames));
    let over20 = 0;
    let over34 = 0;
    let over50 = 0;
    for (let i = 0; i < this.frames; i++) {
      const delta = this.deltas[i] ?? 0;
      if (delta > 20) over20++;
      if (delta > 34) over34++;
      if (delta > 50) over50++;
    }
    return {
      windowMs: round(windowMs, 0),
      frames: this.frames,
      fps: round((this.frames / windowMs) * 1000, 1),
      mapDraws: draws.mapDraws,
      mapDrawsPerSecond: draws.mapDrawsPerSecond,
      frameMs: roundSummary(frameMs),
      framesOver20Ms: over20,
      framesOver34Ms: over34,
      framesOver50Ms: over50,
      longTasks: this.longTaskDurations.length,
      longTaskTotalMs: round(
        this.longTaskDurations.reduce((sum, value) => sum + value, 0),
        1,
      ),
      longTaskMaxMs: round(Math.max(0, ...this.longTaskDurations), 1),
      byZoom: this.zoneFrames(),
    };
  }

  private zoneFrames(): ZoneFrames[] {
    const zones = new Map<number, number[]>();
    for (let i = 0; i < this.frames; i++) {
      const key = Math.floor((this.zooms[i] ?? 0) / ZONE_WIDTH) * ZONE_WIDTH;
      const list = zones.get(key) ?? [];
      list.push(this.deltas[i] ?? 0);
      zones.set(key, list);
    }
    return [...zones.entries()]
      .sort(([a], [b]) => a - b)
      .map(([zoomFrom, deltas]) => {
        const summary = summarize(deltas);
        return {
          zoomFrom,
          frames: deltas.length,
          p50: round(summary.p50),
          p95: round(summary.p95),
          max: round(summary.max),
          over34: deltas.filter((delta) => delta > 34).length,
        };
      });
  }
}

export function roundSummary(summary: Summary): Summary {
  return {
    count: summary.count,
    mean: round(summary.mean),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    max: round(summary.max),
  };
}
