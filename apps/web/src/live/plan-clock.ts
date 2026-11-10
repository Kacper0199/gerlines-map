const MAX_RATE_ADJUSTMENT = 0.02;
const CORRECTION_SECONDS = 10;
const SMOOTHING = 0.5;
/** The difference between a head's time and the clock, in server seconds, past which a time line is another one. */
export const RESTART_AFTER_S = 15;

/**
 * The plan clock of the live worker (Unix seconds): follows the heads' publication times without
 * ever stepping or running backwards. A head tells what the server's clock read when it was
 * published; the difference to this clock is removed by running 2 % faster or slower for a few
 * seconds, so the value is continuous (a train sees no jump in time, only a rate within 2 % of
 * the true one, filtered over successive heads). A difference above 15 s of the server's time (a
 * replay that loops) starts the clock again at the head's time; the first head sets it without
 * counting as a restart.
 */
export class PlanClock {
  private scale: number;
  private base = Number.NaN;
  private baseWall = 0;
  private adjustment = 0;

  constructor(scale: number) {
    this.scale = PlanClock.checked(scale);
  }

  private static checked(scale: number): number {
    if (!(Number.isFinite(scale) && scale > 0)) {
      throw new RangeError(`time scale must be finite and above 0, got ${scale}`);
    }
    return scale;
  }

  setScale(scale: number): void {
    this.scale = PlanClock.checked(scale);
    this.base = Number.NaN;
    this.adjustment = 0;
  }

  /** Plan time in seconds at wall time `wallMs`, null before the first head. */
  now(wallMs: number): number | null {
    return Number.isNaN(this.base)
      ? null
      : this.base + ((wallMs - this.baseWall) / 1000) * this.scale * (1 + this.adjustment);
  }

  /**
   * Takes the time a head carries; true when the clock started again at it (a difference above
   * 15 s), so a caller can drop state tied to the old time line.
   */
  observe(serverTime: number, wallMs: number): boolean {
    const current = this.now(wallMs);
    if (current === null) {
      this.restart(serverTime, wallMs);
      return false;
    }
    const error = serverTime - current;
    if (Math.abs(error) > RESTART_AFTER_S * this.scale) {
      this.restart(serverTime, wallMs);
      return true;
    }
    const wanted = Math.min(
      Math.max(error / (this.scale * CORRECTION_SECONDS), -MAX_RATE_ADJUSTMENT),
      MAX_RATE_ADJUSTMENT,
    );
    this.adjustment += SMOOTHING * (wanted - this.adjustment);
    this.base = current;
    this.baseWall = wallMs;
    return false;
  }

  private restart(serverTime: number, wallMs: number): void {
    this.base = serverTime;
    this.baseWall = wallMs;
    this.adjustment = 0;
  }
}
