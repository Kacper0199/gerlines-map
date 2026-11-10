/**
 * Decides when segments that could not be measured are tried again. A segment waits for the DEM of
 * the tile drawn at its place, so trying again is worth it only after a terrain tile loaded or the
 * view moved, and at most once per gap: a tilted view holds thousands of segments over tiles that
 * are not drawn, and map idle fires on every frame.
 */
export class MeasureRetry {
  private readonly gapMs: number;
  private dirty = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }

  /** A terrain tile loaded or the view moved. */
  changed(): void {
    this.dirty = true;
  }

  /** Everything is measured, so nothing is waiting for a change. */
  settled(): void {
    this.dirty = false;
  }

  due(nowMs: number, unmeasured: number): boolean {
    if (unmeasured === 0 || !this.dirty || nowMs - this.lastAt < this.gapMs) return false;
    this.dirty = false;
    this.lastAt = nowMs;
    return true;
  }
}
