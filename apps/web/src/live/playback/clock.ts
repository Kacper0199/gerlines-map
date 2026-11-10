export const MIN_SPEED = 1;
export const MAX_SPEED = 60;

/**
 * The virtual time of a playback in Unix seconds: it runs at `speed` plan seconds per wall second
 * while playing, holds when paused, and never runs past a limit (the end of the last window it can
 * play). It reads the wall clock only through the arguments, so a test drives it with numbers.
 */
export class PlaybackClock {
  private position: number;
  private anchorWall: number;
  private running: boolean;
  private rate: number;
  private limit = Number.POSITIVE_INFINITY;

  constructor(position: number, speed: number, playing: boolean, wallMs: number) {
    PlaybackClock.check(speed);
    this.position = position;
    this.rate = speed;
    this.running = playing;
    this.anchorWall = wallMs;
  }

  private static check(speed: number): void {
    if (!(Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED)) {
      throw new RangeError(`speed must be ${MIN_SPEED} to ${MAX_SPEED}, got ${speed}`);
    }
  }

  get playing(): boolean {
    return this.running;
  }

  get speed(): number {
    return this.rate;
  }

  now(wallMs: number): number {
    if (!this.running) return Math.min(this.position, this.limit);
    const elapsed = Math.max(0, wallMs - this.anchorWall) / 1000;
    return Math.min(this.position + elapsed * this.rate, this.limit);
  }

  atLimit(wallMs: number): boolean {
    return this.now(wallMs) >= this.limit;
  }

  setLimit(limit: number): void {
    this.limit = limit;
  }

  play(wallMs: number): void {
    if (this.running) return;
    this.anchorWall = wallMs;
    this.running = true;
  }

  pause(wallMs: number): void {
    this.rebase(wallMs);
    this.running = false;
  }

  setSpeed(wallMs: number, speed: number): void {
    PlaybackClock.check(speed);
    this.rebase(wallMs);
    this.rate = speed;
  }

  seek(wallMs: number, position: number): void {
    this.position = position;
    this.anchorWall = wallMs;
  }

  private rebase(wallMs: number): void {
    this.position = this.now(wallMs);
    this.anchorWall = wallMs;
  }
}
