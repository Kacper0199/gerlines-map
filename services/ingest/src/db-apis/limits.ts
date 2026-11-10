import type { Clock } from "../clock.ts";
import { TokenBucket } from "../policy/token-bucket.ts";
import type { ProviderLimit } from "../sources.ts";

export type DbApi = "timetables" | "stada" | "fasta";

const MINUTE = 60_000;

/** The plan limit of DB Timetables (Free): 60 requests per minute for the whole application. */
export const IRIS_PLAN_LIMIT_PER_MINUTE = 60;
export const IRIS_MIN_HEADROOM = 0.3;

/**
 * Per API, the bucket every caller in one process shares. Timetables: one token every 1.5 s and a burst
 * of one, so no rolling minute can see more than 41 requests (31.7 % under the plan limit). StaDa
 * (10 per second) and FaSta (60 per second) are held far lower, since they are read once per run.
 */
export const DB_API_LIMITS: Readonly<Record<DbApi, ProviderLimit>> = {
  timetables: { capacity: 1, refillEveryMs: 1_500 },
  stada: { capacity: 1, refillEveryMs: 1_000 },
  fasta: { capacity: 1, refillEveryMs: 1_000 },
};

/** The most requests a bucket can let through in any rolling window of `windowMs`. */
export function bucketCeiling(limit: ProviderLimit, windowMs = MINUTE): number {
  return limit.capacity + Math.floor(windowMs / limit.refillEveryMs);
}

export interface IrisSchedule {
  readonly stations: number;
  readonly planEveryMs: number;
  readonly fchgEveryMs: number;
  readonly rchgEveryMs: number;
}

/** The cadence chosen for the recorder and the live run: recent changes each minute, full changes every 5 minutes, the next hour's plan once an hour. */
export const IRIS_SCHEDULE_CADENCE = {
  planEveryMs: 60 * MINUTE,
  fchgEveryMs: 5 * MINUTE,
  rchgEveryMs: MINUTE,
} as const;

/**
 * The recorder's long-distance poller (D-041): full changes every 3 minutes, once an hour the plan of the hour
 * `IRIS_PLAN_AHEAD_HOURS` ahead, no recent changes. With the 55 EVAs of `IRIS_LONG_DISTANCE_COVER` that is
 * 55 x (1/3 + 1/60) = 19.25 requests a minute; a start without recent plans adds 3 plans per EVA once
 * (165 for 55 EVAs, about 4 minutes at the bucket's 40 a minute).
 */
/**
 * IRIS names most changes 2 to 4 hours ahead (a probe: 144 of 283 changed trips had no plan of
 * the next hour), so the recorder asks each hour's plan three hours before it.
 */
export const IRIS_PLAN_AHEAD_HOURS = 3;

export const IRIS_RECORDER_CADENCE = {
  planEveryMs: 60 * MINUTE,
  fchgEveryMs: 3 * MINUTE,
} as const;

export interface IrisBudget {
  readonly plannedPerMinute: number;
  readonly ceilingPerMinute: number;
  readonly planLimitPerMinute: number;
  readonly ceilingHeadroom: number;
  readonly spareForOtherCallersPerMinute: number;
}

export function irisBudget(
  schedule: IrisSchedule,
  limit: ProviderLimit = DB_API_LIMITS.timetables,
): IrisBudget {
  const perMinute = (everyMs: number) => (schedule.stations * MINUTE) / everyMs;
  const plannedPerMinute =
    perMinute(schedule.planEveryMs) +
    perMinute(schedule.fchgEveryMs) +
    perMinute(schedule.rchgEveryMs);
  const ceilingPerMinute = bucketCeiling(limit);
  return {
    plannedPerMinute,
    ceilingPerMinute,
    planLimitPerMinute: IRIS_PLAN_LIMIT_PER_MINUTE,
    ceilingHeadroom: 1 - ceilingPerMinute / IRIS_PLAN_LIMIT_PER_MINUTE,
    spareForOtherCallersPerMinute: ceilingPerMinute - plannedPerMinute,
  };
}

/** A token bucket that also holds every caller back while a `Retry-After` from the provider runs. */
export class ApiLimiter {
  private readonly bucket: TokenBucket;
  private readonly clock: Clock;
  private pausedUntil = 0;

  constructor(limit: ProviderLimit, clock: Clock) {
    this.bucket = new TokenBucket(limit, () => clock.now());
    this.clock = clock;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const pause = this.pausedUntil - this.clock.now();
    if (pause > 0) await this.clock.sleep(pause, signal);
    const wait = this.bucket.take();
    if (wait > 0) await this.clock.sleep(wait, signal);
  }

  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  get pausedUntilMs(): number {
    return this.pausedUntil;
  }
}
