import {
  JOURNEY_RELIABILITY_PATH,
  JOURNEY_RELIABILITY_TRAINS_MAX,
  JOURNEYS_PATH,
} from "@gerlines/schema/constants";
import type {
  JourneyReliabilityResponse,
  JourneysResponse,
  TransitLeg,
} from "@gerlines/schema/journeys";
import { loadJourneysSchema } from "../schema-loaders.ts";
import type { FetchLike } from "../search/search-client.ts";
import type { PlannerCategory } from "./planner-url.ts";

export interface JourneySearch {
  readonly from: string;
  readonly to: string;
  /** An ISO instant; the API answers for now when it is null. */
  readonly time: string | null;
  readonly arriveBy: boolean;
  readonly categories: readonly PlannerCategory[] | null;
  readonly operator: string | null;
  readonly cursor?: string | undefined;
}

export const JOURNEY_RESULTS = 5;

export type JourneyError = "busy" | "stop" | "rejected" | "limited" | "invalid" | "unavailable";

export type JourneysFetch =
  | { readonly kind: "ok"; readonly response: JourneysResponse }
  | { readonly kind: "error"; readonly error: JourneyError };

export type ReliabilityFetch =
  | { readonly kind: "ok"; readonly response: JourneyReliabilityResponse }
  | { readonly kind: "error" };

export function journeysUrl(search: JourneySearch): string {
  const params = new URLSearchParams({ from: search.from, to: search.to });
  if (search.cursor) {
    params.set("cursor", search.cursor);
  } else if (search.time) {
    params.set("time", search.time);
  }
  if (search.arriveBy) params.set("arriveBy", "true");
  if (search.categories) params.set("categories", search.categories.join(","));
  if (search.operator) params.set("operators", search.operator);
  params.set("results", String(JOURNEY_RESULTS));
  params.set("geometry", "true");
  return `${JOURNEYS_PATH}?${params}`;
}

const ERRORS_BY_STATUS: Readonly<Record<number, JourneyError>> = {
  400: "invalid",
  404: "stop",
  422: "rejected",
  429: "limited",
};

async function getJson(
  fetch: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ status: number; body: unknown; code: string | null } | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  return { status: response.status, body, code };
}

export async function fetchJourneys(
  search: JourneySearch,
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<JourneysFetch> {
  const schema = loadJourneysSchema().catch(() => null);
  const answer = await getJson(fetch, journeysUrl(search), signal);
  if (answer === null) return { kind: "error", error: "unavailable" };
  if (answer.status === 200) {
    const loaded = await schema;
    if (loaded === null) return { kind: "error", error: "unavailable" };
    const parsed = loaded.JourneysResponse.safeParse(answer.body);
    return parsed.success
      ? { kind: "ok", response: parsed.data }
      : { kind: "error", error: "unavailable" };
  }
  if (answer.status === 503 && answer.code === "router_busy")
    return { kind: "error", error: "busy" };
  return { kind: "error", error: ERRORS_BY_STATUS[answer.status] ?? "unavailable" };
}

const TRAIN_NUMBER = /^[0-9A-Za-z]{1,12}$/;
const OPERATOR_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&()'+-]{0,79}$/u;

/** The reliability key of a leg (category~number~operator), or null when it has no usable number. */
export function reliabilityKeyOf(leg: TransitLeg): string | null {
  if (!(leg.tripNumber && TRAIN_NUMBER.test(leg.tripNumber))) return null;
  const operator = leg.operator?.trim() ?? "";
  const named = operator !== "" && OPERATOR_NAME.test(operator) ? `~${operator}` : "";
  return `${leg.category}~${leg.tripNumber}${named}`;
}

export function reliabilityUrl(keys: readonly string[]): string {
  const params = new URLSearchParams();
  for (const key of keys.slice(0, JOURNEY_RELIABILITY_TRAINS_MAX)) params.append("train", key);
  return `${JOURNEY_RELIABILITY_PATH}?${params}`;
}

export async function fetchReliability(
  keys: readonly string[],
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<ReliabilityFetch> {
  const schema = loadJourneysSchema().catch(() => null);
  const answer = await getJson(fetch, reliabilityUrl(keys), signal);
  if (answer === null || answer.status !== 200) return { kind: "error" };
  const loaded = await schema;
  if (loaded === null) return { kind: "error" };
  const parsed = loaded.JourneyReliabilityResponse.safeParse(answer.body);
  return parsed.success ? { kind: "ok", response: parsed.data } : { kind: "error" };
}
