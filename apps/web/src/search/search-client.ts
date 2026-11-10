import { SEARCH_PATH, SEARCH_QUERY_MAX } from "@gerlines/schema/constants";
import type { SearchLocale, SearchResult, SearchStation } from "@gerlines/schema/search";

import { loadSearchSchema } from "../schema-loaders.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SearchFetch =
  | { readonly kind: "ok"; readonly results: readonly SearchResult[] }
  | { readonly kind: "error"; readonly retryAfterMs?: number };

const RETRY_AFTER_MAX_MS = 120_000;
const DIGIT = /\p{N}/u;
const LETTER = /\p{L}/gu;

/** The query the API is asked with, or null before a digit or two letters are typed. */
export function searchQueryOf(text: string): string | null {
  const trimmed = text.trim().slice(0, SEARCH_QUERY_MAX);
  const letters = trimmed.match(LETTER)?.length ?? 0;
  return DIGIT.test(trimmed) || letters >= 2 ? trimmed : null;
}

export function searchUrl(query: string, locale: SearchLocale): string {
  const params = new URLSearchParams({ q: query, lang: locale });
  return `${SEARCH_PATH}?${params}`;
}

/** The wait a Retry-After value asks for, in seconds or as an HTTP date, capped; none when it is absent, past or unreadable. */
export function retryAfterMsOf(value: string | null, nowMs: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const waitMs = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs;
  return waitMs > 0 ? Math.min(RETRY_AFTER_MAX_MS, waitMs) : undefined;
}

async function readJson(
  fetch: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ status: number; retryAfter: string | null; body: unknown } | null> {
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
  try {
    return {
      status: response.status,
      retryAfter: response.headers?.get("retry-after") ?? null,
      body: response.ok ? await response.json() : null,
    };
  } catch {
    return null;
  }
}

export async function fetchSearch(
  query: string,
  locale: SearchLocale,
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<SearchFetch> {
  const schema = loadSearchSchema().catch(() => null);
  const answer = await readJson(fetch, searchUrl(query, locale), signal);
  if (answer === null) return { kind: "error" };
  if (answer.status !== 200) {
    const retryAfterMs =
      answer.status === 429 || answer.status === 503
        ? retryAfterMsOf(answer.retryAfter, Date.now())
        : undefined;
    return retryAfterMs === undefined ? { kind: "error" } : { kind: "error", retryAfterMs };
  }
  const loaded = await schema;
  if (loaded === null) return { kind: "error" };
  const parsed = loaded.SearchResponse.safeParse(answer.body);
  return parsed.success ? { kind: "ok", results: parsed.data.results } : { kind: "error" };
}

export type StationFetch =
  | { readonly kind: "ok"; readonly station: SearchStation }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

export async function fetchStation(
  id: string,
  { fetch, signal }: { fetch: FetchLike; signal?: AbortSignal },
): Promise<StationFetch> {
  const schema = loadSearchSchema().catch(() => null);
  const answer = await readJson(fetch, `/api/v1/stations/${encodeURIComponent(id)}`, signal);
  if (answer === null) return { kind: "error" };
  if (answer.status === 404) return { kind: "not-found" };
  if (answer.status !== 200) return { kind: "error" };
  const loaded = await schema;
  if (loaded === null) return { kind: "error" };
  const parsed = loaded.SearchStation.safeParse(answer.body);
  return parsed.success && parsed.data.id === id
    ? { kind: "ok", station: parsed.data }
    : { kind: "error" };
}
