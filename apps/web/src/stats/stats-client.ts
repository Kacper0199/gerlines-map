import {
  STATS_PATHS,
  StatsLand,
  StatsLine,
  StatsNetwork,
  StatsStation,
  StatsTrain,
} from "@gerlines/schema/stats";
import type { StatsArea } from "./area.ts";
import type { DayRange } from "./periods.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type StatsData = StatsNetwork | StatsLand | StatsStation | StatsTrain | StatsLine;

export type StatsFailure =
  | "not-configured"
  | "rate-limited"
  | "invalid"
  | "not-found"
  | "unavailable"
  | "unreachable"
  | "unreadable";

export interface StatsFailed {
  readonly kind: StatsFailure;
  /** Seconds the server asked to wait, whole and between 1 and 120, when it said so. */
  readonly retryAfterS?: number;
}

export type StatsFetch = { readonly kind: "ok"; readonly data: StatsData } | StatsFailed;

const MAX_WAIT_S = 120;

/** Whole seconds only; a date or a word in Retry-After is treated as not given. */
export function retryAfterOf(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Math.min(MAX_WAIT_S, Math.max(1, Number(value)));
}

/** `today` asks the server's own idea of today; any other range goes to /period or the area's route. */
export function statsUrl(area: StatsArea, range: DayRange, isToday: boolean): string {
  const query = `?${new URLSearchParams({ from: range.from, to: range.to })}`;
  switch (area.kind) {
    case "network":
      return isToday ? STATS_PATHS.today : `${STATS_PATHS.period}${query}`;
    case "land":
      return `${STATS_PATHS.land.replace("{code}", area.code)}${query}`;
    case "station":
      return `${STATS_PATHS.station.replace("{id}", encodeURIComponent(area.id))}${query}`;
    case "train":
      return `${STATS_PATHS.train.replace("{number}", encodeURIComponent(area.number))}${query}`;
    case "line":
      return `${STATS_PATHS.line.replace("{line}", encodeURIComponent(area.name))}${query}`;
  }
}

function schemaFor(area: StatsArea) {
  switch (area.kind) {
    case "network":
      return StatsNetwork;
    case "land":
      return StatsLand;
    case "station":
      return StatsStation;
    case "train":
      return StatsTrain;
    case "line":
      return StatsLine;
  }
}

export function failureOf(status: number, body: unknown): StatsFailure {
  const code =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : null;
  if (status === 503) return code === "not_configured" ? "not-configured" : "unavailable";
  if (status === 429) return "rate-limited";
  if (status === 400) return "invalid";
  if (status === 404) return "not-found";
  return "unavailable";
}

export async function fetchStats(
  area: StatsArea,
  range: DayRange,
  isToday: boolean,
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<StatsFetch> {
  let response: Response;
  try {
    response = await fetch(statsUrl(area, range, isToday), {
      headers: { accept: "application/json" },
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
    body = null;
  }
  if (!response.ok) {
    const retryAfterS = retryAfterOf(response.headers?.get("retry-after") ?? null);
    const kind = failureOf(response.status, body);
    return retryAfterS === undefined ? { kind } : { kind, retryAfterS };
  }
  const parsed = schemaFor(area).safeParse(body);
  return parsed.success ? { kind: "ok", data: parsed.data } : { kind: "unreadable" };
}
