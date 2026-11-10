import type { ChainChanges } from "./chain.ts";

export interface ScheduledEntry {
  readonly changes: ChainChanges;
  readonly queuedAt: number;
}

/**
 * Plans of a frame hold from the frame's publication time, and the server keeps a train's target
 * continuous only at that instant (the hold rule). A client whose clock is another second would
 * see the new plan against the old one at a time the server never checked, so it applies a frame
 * when its own clock reaches the frame's time: the display then meets the new plan exactly where
 * the headless metric does. A reload replaces everything and is due at once; nothing waits longer
 * than `maxHoldMs` of wall time, so a clock that is wrong cannot freeze the trains.
 */
export class ScheduledChanges {
  private readonly maxHoldMs: number;
  private entries: ScheduledEntry[] = [];

  constructor(maxHoldMs: number) {
    this.maxHoldMs = maxHoldMs;
  }

  get size(): number {
    return this.entries.length;
  }

  reset(): void {
    this.entries = [];
  }

  push(changes: ChainChanges, wallMs: number): void {
    if (!changes.reloaded && changes.changed.length === 0 && changes.removed.length === 0) return;
    if (changes.reloaded) this.entries = [];
    this.entries.push({ changes, queuedAt: wallMs });
  }

  /** The entries due at plan time `planNow` (or overdue by wall time), oldest first. */
  due(planNow: number, wallMs: number): ScheduledEntry[] {
    const out: ScheduledEntry[] = [];
    while (this.entries.length > 0) {
      const next = this.entries[0] as ScheduledEntry;
      const ready = next.changes.reloaded || next.changes.time <= planNow;
      const overdue = wallMs - next.queuedAt >= this.maxHoldMs;
      if (!(ready || overdue)) break;
      out.push(next);
      this.entries.shift();
    }
    return out;
  }
}
