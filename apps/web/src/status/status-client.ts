import { DataStatus, STATUS_CACHE_S, STATUS_PATH } from "@gerlines/schema/status";
import {
  type FetchLike,
  failureOf,
  retryAfterOf,
  type StatsFailed,
} from "../stats/stats-client.ts";

export type StatusFetch =
  | {
      readonly kind: "ok";
      readonly data: DataStatus;
      /** Seconds the answer was held by the server and caches before it arrived. */
      readonly ageS: number;
    }
  | StatsFailed;

function seconds(value: string | null | undefined): number | null {
  return value !== null && value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

/**
 * The server sends `max-age` with the seconds its answer stays current out of 30, and a CDN adds
 * `Age`, so the answer's age on arrival needs neither clock to agree with the other.
 */
export function answerAgeOf(headers: Headers | undefined): number {
  const maxAge = seconds(/max-age=(\d+)/.exec(headers?.get("cache-control") ?? "")?.[1]);
  const age = seconds(headers?.get("age")) ?? 0;
  const held = maxAge === null ? 0 : Math.max(0, STATUS_CACHE_S - maxAge);
  return Math.min(held + age, 10 * STATUS_CACHE_S);
}

/**
 * One read of `GET /api/v1/status`; a failure says why and how long the server asked to wait. It
 * asks past the browser's own cache, whose copy would hide how long it was kept.
 */
export async function fetchStatus({
  fetch,
  signal,
}: {
  fetch: FetchLike;
  signal?: AbortSignal;
}): Promise<StatusFetch> {
  let response: Response;
  try {
    response = await fetch(STATUS_PATH, {
      headers: { accept: "application/json" },
      cache: "no-cache",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unreachable" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  if (!response.ok) {
    const retryAfterS = retryAfterOf(response.headers?.get("retry-after") ?? null);
    const kind = failureOf(response.status, body);
    return retryAfterS === undefined ? { kind } : { kind, retryAfterS };
  }
  const parsed = DataStatus.safeParse(body);
  return parsed.success
    ? { kind: "ok", data: parsed.data, ageS: answerAgeOf(response.headers) }
    : { kind: "unreadable" };
}
