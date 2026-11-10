import { round } from "./stats.ts";

export interface DrawCount {
  mapDraws: number;
  mapDrawsPerSecond: number;
}

export class DrawCounter {
  private count = 0;
  private startedAt = 0;
  private running = false;

  start(now: number): void {
    this.count = 0;
    this.startedAt = now;
    this.running = true;
  }

  note(): void {
    if (this.running) this.count++;
  }

  stop(now: number): DrawCount {
    this.running = false;
    const seconds = (now - this.startedAt) / 1000;
    return {
      mapDraws: this.count,
      mapDrawsPerSecond: seconds > 0 ? round(this.count / seconds, 1) : 0,
    };
  }
}

export interface DrawSources {
  probe: { windowMs: number; mapDrawsPerSecond?: number };
  gpuSamples?: number;
}

export function mapDrawsPerSecondOf(measured: DrawSources): number | null {
  const counted = measured.probe.mapDrawsPerSecond;
  if (counted !== undefined) return counted;
  const samples = measured.gpuSamples;
  if (!samples || measured.probe.windowMs <= 0) return null;
  return round((samples / measured.probe.windowMs) * 1000, 1);
}
