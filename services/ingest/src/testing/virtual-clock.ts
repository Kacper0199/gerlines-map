import type { Clock } from "../clock.ts";

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly wake: () => void;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock for tests whose time moves only when `runUntil` advances it, timer by timer. */
export class VirtualClock implements Clock {
  private time: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start: number) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer: Timer = { at: this.time + ms, seq: this.seq++, wake: () => done() };
      const done = () => {
        this.timers = this.timers.filter((other) => other !== timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.timers.push(timer);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Fires every timer due up to `end` in time order, letting pending work settle after each one. */
  async runUntil(end: number): Promise<void> {
    for (;;) {
      await settle();
      const next = this.timers.reduce<Timer | null>(
        (first, timer) =>
          first === null || timer.at < first.at || (timer.at === first.at && timer.seq < first.seq)
            ? timer
            : first,
        null,
      );
      if (next === null || next.at > end) break;
      this.time = Math.max(this.time, next.at);
      next.wake();
    }
    this.time = Math.max(this.time, end);
    await settle();
  }
}
