import { useMemo } from "react";
import { berlinDay, type DayRange, periodRange, validateRange } from "../stats/periods.ts";
import { useStatsStore } from "../stats/store.ts";

const DEFAULT_DAYS = { kind: "days", count: 30 } as const;

/**
 * The period of the profile: the one chosen in the statistics panel, except Today (one day tells little about a
 * segment), which becomes the last 30 days. An unfinished custom period falls back to the same.
 */
export function profileRange(
  period: ReturnType<typeof useStatsStore.getState>["period"],
  today: string,
): DayRange {
  if (period.kind !== "today") {
    const range = periodRange(period, today);
    if (validateRange(range.from, range.to).ok) return range;
  }
  return periodRange(DEFAULT_DAYS, today);
}

export function useProfileRange(): DayRange {
  const period = useStatsStore((state) => state.period);
  const today = berlinDay(Date.now());
  return useMemo(() => profileRange(period, today), [period, today]);
}
