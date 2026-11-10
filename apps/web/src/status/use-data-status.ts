import type { DataStatus } from "@gerlines/schema/status";
import { useCallback, useEffect, useState } from "react";
import type { FetchLike, StatsFailed } from "../stats/stats-client.ts";
import { fetchStatus } from "./status-client.ts";

export const STATUS_REFRESH_MS = 30_000;

export type StatusLoad =
  | { readonly state: "loading" }
  | {
      readonly state: "ready";
      readonly data: DataStatus;
      readonly refreshFailed: boolean;
      /** When the server read the answer, on this device's clock. */
      readonly answeredAt: number;
    }
  | ({ readonly state: "failed" } & StatsFailed);

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * Reads the data status while the popover is open: at once, then every 30 s (the server's own
 * cache period). A failed refresh keeps the last answer and says so; a refusal waits its Retry-After.
 */
export function useDataStatus(
  fetch: FetchLike = browserFetch,
  now: () => number = Date.now,
): {
  readonly load: StatusLoad;
  readonly retry: () => void;
} {
  const [load, setLoad] = useState<StatusLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt restarts the reads
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let result: Awaited<ReturnType<typeof fetchStatus>>;
      try {
        result = await fetchStatus({ fetch, signal: controller.signal });
      } catch {
        return;
      }
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setLoad({
          state: "ready",
          data: result.data,
          refreshFailed: false,
          answeredAt: now() - result.ageS * 1000,
        });
      } else {
        setLoad((previous) =>
          previous.state === "ready"
            ? { ...previous, refreshFailed: true }
            : { state: "failed", ...result },
        );
      }
      const waitMs =
        result.kind === "ok" || result.retryAfterS === undefined
          ? STATUS_REFRESH_MS
          : Math.max(STATUS_REFRESH_MS, result.retryAfterS * 1000);
      timer = setTimeout(read, waitMs);
    };
    void read();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fetch, now, attempt]);
  return { load, retry };
}
