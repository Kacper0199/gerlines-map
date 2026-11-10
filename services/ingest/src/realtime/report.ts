import { addDays, localDate, serviceInstant } from "@gerlines/schema/service-day";
import type { Matcher } from "./matcher.ts";
import type { Processor } from "./processor.ts";
import { NO_TIME, type TripRun } from "./timetable.ts";

function countBy(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 100;

/**
 * Match rate per source: distinct timetable runs matched against distinct source trips that are
 * trains but found no run (out of scope, such as buses in DELFI, is counted apart and not in the rate).
 */
export function coverageReport(processor: Processor) {
  const result: Record<string, unknown> = {};
  for (const [source, coverage] of [...processor.coverage.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const matched = coverage.matched.size;
    const unmatched = coverage.unmatched.size;
    result[source] = {
      payloads: coverage.payloads,
      failedPayloads: coverage.failedPayloads,
      rebuilds: coverage.rebuilds,
      skippedPayloads: coverage.skipped,
      lateDaysNotRebuilt: coverage.daysTooOld,
      matchedRuns: matched,
      matchedByCategory: countBy(coverage.matched.values()),
      matchedByMethod: Object.fromEntries(
        [...coverage.matchedByMethod.entries()].map(([method, runs]) => [method, runs.size]),
      ),
      unmatchedTrips: unmatched,
      unmatchedByReason: countBy(coverage.unmatched.values()),
      outOfScopeTrips: coverage.outOfScope.size,
      outOfScopeByReason: countBy(coverage.outOfScope.values()),
      matchRatePercent: share(matched, matched + unmatched),
      implausibleEarlyDelays: coverage.implausibleDelays,
      timesKeptInOrder: coverage.reordered,
      payloadsByFeedVersion: Object.fromEntries(
        [...coverage.feedVersions.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  return { sources: result };
}

function runSpan(run: TripRun): [number, number] {
  const times = [...run.trip.arrivals, ...run.trip.departures].filter((value) => value !== NO_TIME);
  return [
    serviceInstant(run.serviceDate, Math.min(...times)),
    serviceInstant(run.serviceDate, Math.max(...times)),
  ];
}

/**
 * Per category, timetable runs (foreign ones apart) scheduled to be under way at some point in the
 * window, and how many of them any source matched: the share of trains the map can show live.
 */
export function timetableCoverage(
  processor: Processor,
  matcher: Matcher,
  window: { from: number; to: number },
) {
  const matched = new Set<string>();
  for (const coverage of processor.coverage.values()) {
    for (const instance of coverage.matched.keys()) matched.add(instance);
  }
  const days: string[] = [];
  for (let day = addDays(localDate(window.from), -1); day <= localDate(window.to); ) {
    days.push(day);
    day = addDays(day, 1);
  }
  const scheduled = new Map<string, Set<string>>();
  for (const day of days) {
    for (const run of matcher.forServiceDate(day).runsOn(day).values()) {
      const [first, last] = runSpan(run);
      if (last < window.from || first > window.to) continue;
      const key = `${run.trip.categoryCode}${run.trip.isForeign ? "-foreign" : ""}`;
      const runs = scheduled.get(key) ?? new Set<string>();
      runs.add(run.instanceId);
      scheduled.set(key, runs);
    }
  }
  return Object.fromEntries(
    [...scheduled.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, runs]) => {
        const live = [...runs].filter((instance) => matched.has(instance)).length;
        return [category, { scheduled: runs.size, live, livePercent: share(live, runs.size) }];
      }),
  );
}
