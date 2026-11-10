const MINUTE = 60_000;
const TRAVEL_PRIMARY = "delfi-mobilithek-rt";

/**
 * The light source set for metered networks: the official DELFI feed every 5 minutes (about 1.5 MB gzip a
 * fetch, so about 430 MB a day) and the DELFI alerts every 15 minutes. Every other source waits and its time
 * becomes a recorded gap; DELFI minutes can be backfilled from the traines mirror later.
 */
export const TRAVEL_PERIODS: Readonly<Record<string, number>> = {
  [TRAVEL_PRIMARY]: 5 * MINUTE,
  "delfi-gtfs-sa": 15 * MINUTE,
};

/** Without Mobilithek access, the mirror's hourly de-incremented checkpoint stands in for the DELFI feed. */
export const TRAVEL_FALLBACK_PERIODS: Readonly<Record<string, number>> = {
  "delfi-gtfs-rt-deincr": 60 * MINUTE,
};

/** Source id to travel cadence, for the sources this recorder actually runs. */
export function travelPlan(runningIds: readonly string[]): ReadonlyMap<string, number> {
  const running = new Set(runningIds);
  const periods = running.has(TRAVEL_PRIMARY)
    ? TRAVEL_PERIODS
    : { ...TRAVEL_PERIODS, ...TRAVEL_FALLBACK_PERIODS };
  return new Map(Object.entries(periods).filter(([id]) => running.has(id)));
}
