/** The view summary is read out at most this often (WCAG 4.1.3 without chatter while the map is dragged). */
export const SUMMARY_GAP_MS = 10_000;

export interface AnnouncerOptions {
  readonly gapMs: number;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => number;
  readonly clearTimer: (id: number) => void;
  readonly announce: () => void;
}

export interface Announcer {
  /** The user moved the map: announce now, or when the gap since the last announcement is over. */
  moved(): void;
  dispose(): void;
}

export function createAnnouncer(options: AnnouncerOptions): Announcer {
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: number | null = null;
  return {
    moved() {
      if (timer !== null) return;
      const wait = Math.max(0, lastAt + options.gapMs - options.now());
      timer = options.setTimer(() => {
        timer = null;
        lastAt = options.now();
        options.announce();
      }, wait);
    },
    dispose() {
      if (timer !== null) options.clearTimer(timer);
      timer = null;
    },
  };
}
