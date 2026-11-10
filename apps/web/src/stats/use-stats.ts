import { useCallback, useEffect, useRef, useState } from "react";
import { type StatsArea, sameArea } from "./area.ts";
import { type DayRange, validateRange } from "./periods.ts";
import { type FetchLike, fetchStats, type StatsData, type StatsFailure } from "./stats-client.ts";

export type StatsView =
  | { readonly state: "idle"; readonly data: null }
  | { readonly state: "loading"; readonly data: null }
  | { readonly state: "refreshing"; readonly data: StatsData }
  | { readonly state: "ready"; readonly data: StatsData }
  | {
      readonly state: "failed";
      readonly failure: StatsFailure;
      readonly retryAfterS?: number;
      readonly data: null;
    };

interface Held {
  readonly area: StatsArea;
  readonly data: StatsData;
}

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * The answer for an area and a range. While a new answer loads, the previous one of the same
 * area stays in place (`refreshing`), so the panel keeps its frame; another area starts empty.
 */
export function useStats(
  area: StatsArea | null,
  range: DayRange,
  isToday: boolean,
  fetch: FetchLike = browserFetch,
): { view: StatsView; retry: () => void } {
  const [view, setView] = useState<StatsView>({ state: "idle", data: null });
  const [attempt, setAttempt] = useState(0);
  const held = useRef<Held | null>(null);
  const valid = validateRange(range.from, range.to).ok;
  const areaKey = JSON.stringify(area);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the area is compared by its key
  useEffect(() => {
    if (area === null) {
      held.current = null;
      setView({ state: "idle", data: null });
      return;
    }
    if (!valid) return;
    const controller = new AbortController();
    const previous =
      held.current !== null && sameArea(held.current.area, area) ? held.current : null;
    if (previous === null) held.current = null;
    setView(
      previous === null
        ? { state: "loading", data: null }
        : { state: "refreshing", data: previous.data },
    );
    fetchStats(area, range, isToday, { fetch, signal: controller.signal }).then(
      (answer) => {
        if (controller.signal.aborted) return;
        if (answer.kind === "ok") {
          held.current = { area, data: answer.data };
          setView({ state: "ready", data: answer.data });
          return;
        }
        held.current = null;
        setView({
          state: "failed",
          failure: answer.kind,
          ...(answer.retryAfterS === undefined ? {} : { retryAfterS: answer.retryAfterS }),
          data: null,
        });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [areaKey, range.from, range.to, isToday, valid, attempt, fetch]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { view, retry };
}
