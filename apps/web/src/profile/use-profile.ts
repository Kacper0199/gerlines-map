import type { StatsTrainSegments } from "@gerlines/schema/stats";
import { useCallback, useEffect, useState } from "react";
import type { DayRange } from "../stats/periods.ts";
import type { StatsFailure } from "../stats/stats-client.ts";
import { type FetchLike, fetchProfile, type ProfileSubject, profileUrl } from "./profile-client.ts";

export type ProfileView =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: StatsTrainSegments }
  | { readonly state: "failed"; readonly failure: StatsFailure; readonly retryAfterS?: number };

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** The API caches settled periods for an hour; the same request within five minutes is not asked twice. */
const MEMORY_MS = 5 * 60_000;
const memory = new Map<string, { readonly at: number; readonly data: StatsTrainSegments }>();

const MEMORY_ENTRIES = 20;

export function clearProfileCache(): void {
  memory.clear();
}

export function profileCacheSize(): number {
  return memory.size;
}

/** The fresh answer for a request; an older one is dropped on the way, so the memory holds no dead entries. */
function remembered(url: string): StatsTrainSegments | undefined {
  const held = memory.get(url);
  if (held === undefined) return undefined;
  if (Date.now() - held.at < MEMORY_MS) return held.data;
  memory.delete(url);
  return undefined;
}

function remember(url: string, data: StatsTrainSegments): void {
  memory.delete(url);
  memory.set(url, { at: Date.now(), data });
  for (const key of memory.keys()) {
    if (memory.size <= MEMORY_ENTRIES) break;
    memory.delete(key);
  }
}

/** The held answer whatever its age: a render shows it until the effect has asked again, and never reads the clock. */
function held(url: string): StatsTrainSegments | undefined {
  return memory.get(url)?.data;
}

/** The segment profile of a train number for a period, fetched only while `enabled`. */
export function useProfile(
  subject: ProfileSubject,
  range: DayRange,
  enabled: boolean,
  fetch: FetchLike = browserFetch,
): { view: ProfileView; retry: () => void } {
  const url = profileUrl(subject, range);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ url: string; view: ProfileView } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the request is compared by its url
  useEffect(() => {
    if (!enabled) return;
    const fresh = remembered(url);
    if (fresh) {
      setLoaded({ url, view: { state: "ready", data: fresh } });
      return;
    }
    const controller = new AbortController();
    fetchProfile(subject, range, { fetch, signal: controller.signal }).then(
      (answer) => {
        if (controller.signal.aborted) return;
        if (answer.kind === "ok") {
          remember(url, answer.data);
          setLoaded({ url, view: { state: "ready", data: answer.data } });
          return;
        }
        setLoaded({
          url,
          view: {
            state: "failed",
            failure: answer.kind,
            ...(answer.retryAfterS === undefined ? {} : { retryAfterS: answer.retryAfterS }),
          },
        });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [enabled, url, attempt, fetch]);

  const retry = useCallback(() => {
    memory.delete(url);
    setLoaded(null);
    setAttempt((count) => count + 1);
  }, [url]);

  let view: ProfileView = { state: "idle" };
  if (enabled) {
    const kept = held(url);
    if (loaded?.url === url) view = loaded.view;
    else if (kept) view = { state: "ready", data: kept };
    else view = { state: "loading" };
  }
  return { view, retry };
}
