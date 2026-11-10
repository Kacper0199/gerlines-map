import type { SearchLocale, SearchResult } from "@gerlines/schema/search";
import { useEffect, useState } from "react";
import { type FetchLike, fetchSearch, searchQueryOf } from "./search-client.ts";

export const SEARCH_DEBOUNCE_MS = 150;

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly query: string }
  | { readonly status: "ready"; readonly query: string; readonly results: readonly SearchResult[] }
  | { readonly status: "error"; readonly query: string; readonly retryAt?: number };

export interface UseSearchOptions {
  readonly fetch?: FetchLike;
  readonly debounceMs?: number;
}

/**
 * Results for the typed text: asked once the typing pauses, the previous request cancelled, the
 * last results kept on screen while the next ones load. `attempt` repeats a failed request; a
 * refusal that named a wait carries the time (`retryAt`) before which no repeat is made.
 */
export function useSearch(
  text: string,
  locale: SearchLocale,
  attempt: number,
  { fetch = browserFetch, debounceMs = SEARCH_DEBOUNCE_MS }: UseSearchOptions = {},
): SearchState {
  const query = searchQueryOf(text);
  const [state, setState] = useState<SearchState>({ status: "idle" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt repeats the request
  useEffect(() => {
    if (query === null) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading", query }));
    const timer = setTimeout(() => {
      fetchSearch(query, locale, { fetch, signal: controller.signal })
        .then((answer) => {
          if (controller.signal.aborted) return;
          setState(
            answer.kind === "ok"
              ? { status: "ready", query, results: answer.results }
              : {
                  status: "error",
                  query,
                  ...(answer.retryAfterMs === undefined
                    ? {}
                    : { retryAt: Date.now() + answer.retryAfterMs }),
                },
          );
        })
        .catch(() => undefined);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, locale, attempt, fetch, debounceMs]);
  return state;
}
