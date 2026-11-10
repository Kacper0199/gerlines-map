import { encodeHead } from "@gerlines/live-frame";
import { Hono } from "hono";
import type { HeadEntry } from "../evidence/continuity.ts";
import { createLiveApp, type ObjectSource } from "./app.ts";

/** The head published at or before `time` in a list ordered by time, null before the first. */
export function headAt(heads: readonly HeadEntry[], time: number): HeadEntry | null {
  let low = 0;
  let high = heads.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((heads[middle] as HeadEntry)[0] <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found < 0 ? null : (heads[found] as HeadEntry);
}

export interface ReplayClockOptions {
  /** Time of the first and the last recorded head, Unix seconds. */
  readonly first: number;
  readonly last: number;
  /** Replay seconds per wall second. */
  readonly speed: number;
  /** Start again at the first head after the last one (clients see a restart and reload). */
  readonly loop: boolean;
  readonly wall: () => number;
  readonly startAt?: number;
}

/** The virtual time of a replay of recorded heads: runs at `speed` from `startAt`, stops or loops at the end. */
export class ReplayClock {
  private readonly options: ReplayClockOptions;
  private readonly origin: number;
  private readonly start: number;

  constructor(options: ReplayClockOptions) {
    if (!(Number.isFinite(options.speed) && options.speed > 0)) {
      throw new RangeError(`replay speed must be above 0, got ${options.speed}`);
    }
    this.options = options;
    this.origin = options.wall();
    this.start = Math.min(Math.max(options.startAt ?? options.first, options.first), options.last);
  }

  get first(): number {
    return this.options.first;
  }

  get last(): number {
    return this.options.last;
  }

  get speed(): number {
    return this.options.speed;
  }

  now(): number {
    const { first, last, speed, loop, wall } = this.options;
    const virtual = this.start + (wall() - this.origin) * speed;
    if (virtual <= last) return virtual;
    if (!loop) return last;
    const span = last - first + 1;
    return first + ((virtual - first) % span);
  }
}

export interface ReplayOptions {
  readonly frames: ObjectSource;
  readonly packs: ObjectSource;
  readonly heads: readonly HeadEntry[];
  readonly clock: ReplayClock;
}

/**
 * The `/live/v1/*` routes over a finished render: objects come from the render's store, shape
 * packs from a pack store, and `head` is the head the render published at the replay's virtual
 * time, so a client sees the chain grow as it did when it was rendered. Not for production: it
 * serves recorded states, nothing is computed.
 */
export function createReplayApp(options: ReplayOptions): Hono {
  const { frames, packs, heads, clock } = options;
  const objects = createLiveApp({
    read: (relative) => (relative.startsWith("s/") ? packs.read(relative) : frames.read(relative)),
  });
  const app = new Hono();
  app.get("/live/v1/head", () => {
    const entry = headAt(heads, clock.now());
    if (!entry) return new Response(null, { status: 404 });
    const [timeBase, sequence, keyframeSequence, oldestSequence, timetableVersion] = entry;
    const bytes = encodeHead({
      kind: "head",
      sequence,
      timetableVersion,
      timeBase,
      keyframeSequence,
      oldestSequence,
    });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=1",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
  app.get("/replay/state", (c) =>
    c.json({
      virtualNow: clock.now(),
      speed: clock.speed,
      first: clock.first,
      last: clock.last,
    }),
  );
  app.route("/", objects);
  return app;
}
