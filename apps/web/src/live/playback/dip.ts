type Phase = "idle" | "out" | "hold" | "in";

/**
 * The look of a seek: the trains fade out over the old state, the state is swapped while they are
 * invisible, and the trains of the new state fade in once it is loaded. It holds at zero for as long
 * as the load takes, so no train is ever drawn at a position that belongs to the other time. With
 * zero durations (reduced motion) it never dims and the swap is due at once.
 */
export class SeekDip {
  private readonly outMs: number;
  private readonly inMs: number;
  private phase: Phase = "idle";
  private since = 0;
  private from = 1;

  constructor(outMs: number, inMs: number) {
    this.outMs = outMs;
    this.inMs = inMs;
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  /** The old state is still on screen and fading out. */
  get fadingOut(): boolean {
    return this.phase === "out";
  }

  /** A seek starts: from the opacity the trains have now. */
  begin(wallMs: number): void {
    this.from = this.opacity(wallMs);
    this.phase = "out";
    this.since = wallMs;
  }

  /** True once the fade-out is done and the swap has not happened yet. */
  swapDue(wallMs: number): boolean {
    return this.phase === "out" && wallMs - this.since >= this.outMs * this.from;
  }

  swapped(): void {
    if (this.phase === "out") this.phase = "hold";
  }

  /** The new state is on screen: fade in. */
  release(wallMs: number): void {
    if (this.phase !== "hold") return;
    if (this.inMs === 0) {
      this.phase = "idle";
      return;
    }
    this.phase = "in";
    this.since = wallMs;
  }

  opacity(wallMs: number): number {
    switch (this.phase) {
      case "idle":
        return 1;
      case "hold":
        return this.inMs === 0 ? 1 : 0;
      case "out": {
        if (this.outMs === 0) return 1;
        const progress = Math.min(1, (wallMs - this.since) / (this.outMs * this.from));
        return this.from * (1 - progress);
      }
      case "in": {
        const progress = Math.min(1, (wallMs - this.since) / this.inMs);
        if (progress >= 1) this.phase = "idle";
        return progress;
      }
    }
  }
}
