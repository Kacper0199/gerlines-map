/** Paths and limits the page needs before any answer is parsed; this module imports no schema library. */

export const SEARCH_QUERY_MAX = 80;
export const SEARCH_PATH = "/api/v1/search";

export const JOURNEYS_PATH = "/api/v1/journeys";
export const JOURNEY_RELIABILITY_PATH = "/api/v1/journeys/reliability";
export const JOURNEY_OPERATOR_TERMS_MAX = 5;
export const JOURNEY_OPERATOR_TERM_MIN = 2;
export const JOURNEY_OPERATOR_TERM_MAX = 40;
export const JOURNEY_RELIABILITY_TRAINS_MAX = 30;

export function trainDetailPath(tripInstanceId: string): string {
  return `/api/v1/trains/${encodeURIComponent(tripInstanceId)}`;
}

export function liveKeyPath(frameKey: number): string {
  return `/api/v1/live/keys/${frameKey}`;
}
