import {
  StatsTrainSegments as Schema,
  STATS_PATHS,
  type StatsTrainSegments,
} from "@gerlines/schema/stats";
import type { DayRange } from "../stats/periods.ts";
import {
  type FetchLike,
  failureOf,
  retryAfterOf,
  type StatsFailed,
} from "../stats/stats-client.ts";

export type { FetchLike };

/** Whose profile to ask for: a train number, narrowed to the card's category and operator. */
export interface ProfileSubject {
  readonly number: string;
  readonly category: string;
  readonly operatorId: string | null;
}

export type ProfileFetch = { readonly kind: "ok"; readonly data: StatsTrainSegments } | StatsFailed;

const OPERATOR_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** One number is often several trains, so the category and operator of the card go with the request. */
export function profileUrl(subject: ProfileSubject, range: DayRange): string {
  const query = new URLSearchParams({
    from: range.from,
    to: range.to,
    category: subject.category,
  });
  if (subject.operatorId !== null && OPERATOR_ID.test(subject.operatorId)) {
    query.set("operator", subject.operatorId);
  }
  const path = STATS_PATHS.trainSegments.replace("{number}", encodeURIComponent(subject.number));
  return `${path}?${query}`;
}

export async function fetchProfile(
  subject: ProfileSubject,
  range: DayRange,
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<ProfileFetch> {
  let response: Response;
  try {
    response = await fetch(profileUrl(subject, range), {
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
  }
  if (!response.ok) {
    const retryAfterS = retryAfterOf(response.headers?.get("retry-after") ?? null);
    const kind = failureOf(response.status, body);
    return retryAfterS === undefined ? { kind } : { kind, retryAfterS };
  }
  const parsed = Schema.safeParse(body);
  return parsed.success ? { kind: "ok", data: parsed.data } : { kind: "unreadable" };
}
