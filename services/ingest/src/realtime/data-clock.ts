import type { Clock } from "../clock.ts";

/**
 * The processing clock of a live run: the observed instant of the newest payload handed on, never
 * ahead of the wall clock and never backwards. While a run catches up on hours or days of
 * recordings it reads the recordings' time, so day changes, version checks, holds and the horizon
 * follow the data; once caught up it trails the wall clock by the recorder's delay. A held fallback
 * payload is released only once a payload observed after its instant has come, so no payload still
 * to come can order before it.
 */
export class DataClock implements Clock {
  readonly wall: Clock;
  private newest: number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(wall: Clock, start: number) {
    this.wall = wall;
    this.newest = start;
  }

  /** Notes the observed instant of a payload about to be handed on. */
  observe(epochMs: number): void {
    if (epochMs > this.newest) this.newest = epochMs;
  }

  now(): number {
    const at = Math.min(this.wall.now(), this.newest);
    if (at > this.last) this.last = at;
    return this.last;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.wall.sleep(ms, signal);
  }
}
