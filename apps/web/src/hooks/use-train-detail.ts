import { TrainDetail, trainDetailPath } from "@gerlines/schema";
import { useCallback, useEffect, useRef, useState } from "react";

export type TrainDetailErrorCode = "unreachable" | "server_error" | "unreadable";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TrainDetailFetch =
  | { readonly kind: "ok"; readonly detail: TrainDetail; readonly etag: string | null }
  | { readonly kind: "not-modified" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly code: TrainDetailErrorCode };

export interface FetchTrainDetailOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly etag?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * The detail as this bundle reads it. A photo of a shape the bundle does not know, from a newer or
 * older API, is dropped to `null` so the card still shows the train; any other problem refuses it.
 */
function parseDetail(body: unknown): ReturnType<typeof TrainDetail.safeParse> {
  const parsed = TrainDetail.safeParse(body);
  if (parsed.success || typeof body !== "object" || body === null) return parsed;
  if (!parsed.error.issues.every((issue) => issue.path[0] === "photo")) return parsed;
  return TrainDetail.safeParse({ ...body, photo: null });
}

export async function fetchTrainDetail(
  tripInstanceId: string,
  { fetch, baseUrl = "", etag = null, signal }: FetchTrainDetailOptions,
): Promise<TrainDetailFetch> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${trainDetailPath(tripInstanceId)}`, {
      headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return { kind: "error", code: "unreachable" };
  }
  if (response.status === 304) {
    return { kind: "not-modified" };
  }
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (!response.ok) {
    return { kind: "error", code: "server_error" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "error", code: "unreadable" };
  }
  const parsed = parseDetail(body);
  if (!parsed.success || parsed.data.tripInstanceId !== tripInstanceId) {
    return { kind: "error", code: "unreadable" };
  }
  return { kind: "ok", detail: parsed.data, etag: response.headers.get("etag") };
}

export type TrainDetailResult =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly detail: TrainDetail;
      readonly refreshError: TrainDetailErrorCode | null;
      readonly fetchedAtMs: number;
    }
  | { readonly status: "not-found"; readonly retry: () => void }
  | { readonly status: "error"; readonly code: TrainDetailErrorCode; readonly retry: () => void };

export interface UseTrainDetailOptions {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly refreshMs?: number;
  readonly clock?: () => number;
}

export const TRAIN_DETAIL_REFRESH_MS = 10_000;
export const MAX_BACKOFF_MS = 60_000;
const MISSES_BEFORE_GONE = 2;

type Snapshot =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly detail: TrainDetail;
      readonly refreshError: TrainDetailErrorCode | null;
      readonly fetchedAtMs: number;
    }
  | { readonly status: "not-found" }
  | { readonly status: "error"; readonly code: TrainDetailErrorCode };

export interface PollState {
  readonly detail: TrainDetail | null;
  readonly etag: string | null;
  readonly fetchedAtMs: number;
  readonly misses: number;
  readonly failures: number;
}

export const INITIAL_POLL: PollState = {
  detail: null,
  etag: null,
  fetchedAtMs: 0,
  misses: 0,
  failures: 0,
};

export interface PollStep {
  readonly snapshot: Snapshot;
  readonly state: PollState;
  readonly again: boolean;
}

function olderThanHeld(held: TrainDetail | null, next: TrainDetail): boolean {
  return (
    held !== null && held.timetableVersion === next.timetableVersion && next.version < held.version
  );
}

function ready(state: PollState, refreshError: TrainDetailErrorCode | null): Snapshot {
  return state.detail
    ? { status: "ready", detail: state.detail, refreshError, fetchedAtMs: state.fetchedAtMs }
    : { status: "loading" };
}

export function pollStep(result: TrainDetailFetch, state: PollState, nowMs: number): PollStep {
  switch (result.kind) {
    case "ok": {
      const next: PollState = olderThanHeld(state.detail, result.detail)
        ? { ...state, fetchedAtMs: nowMs, misses: 0, failures: 0 }
        : { detail: result.detail, etag: result.etag, fetchedAtMs: nowMs, misses: 0, failures: 0 };
      return { snapshot: ready(next, null), state: next, again: true };
    }
    case "not-modified": {
      const next = state.detail
        ? { ...state, fetchedAtMs: nowMs, misses: 0, failures: 0 }
        : { ...INITIAL_POLL };
      return { snapshot: ready(next, null), state: next, again: true };
    }
    case "not-found": {
      const misses = state.misses + 1;
      if (state.detail && misses < MISSES_BEFORE_GONE) {
        const next = { ...state, misses };
        return { snapshot: ready(next, null), state: next, again: true };
      }
      return { snapshot: { status: "not-found" }, state: INITIAL_POLL, again: false };
    }
    default: {
      if (state.detail) {
        const next = { ...state, misses: 0, failures: state.failures + 1 };
        return { snapshot: ready(next, result.code), state: next, again: true };
      }
      return {
        snapshot: { status: "error", code: result.code },
        state: INITIAL_POLL,
        again: false,
      };
    }
  }
}

export function nextPollDelay(refreshMs: number, failures: number): number {
  return Math.min(refreshMs * 2 ** failures, Math.max(refreshMs, MAX_BACKOFF_MS));
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.status === "ready" && b.status === "ready") {
    return (
      a.detail === b.detail && a.refreshError === b.refreshError && a.fetchedAtMs === b.fetchedAtMs
    );
  }
  return a.status === b.status && a.status !== "error";
}

interface Keyed {
  readonly id: string | null;
  readonly attempt: number;
  readonly value: Snapshot;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function useTrainDetail(
  tripInstanceId: string | null,
  { fetch, baseUrl, refreshMs = TRAIN_DETAIL_REFRESH_MS, clock }: UseTrainDetailOptions = {},
): TrainDetailResult {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Keyed>({
    id: tripInstanceId,
    attempt,
    value: { status: "loading" },
  });
  const fetchRef = useRef(fetch);
  const clockRef = useRef(clock);
  useEffect(() => {
    fetchRef.current = fetch;
    clockRef.current = clock;
  });

  useEffect(() => {
    if (tripInstanceId === null) {
      return;
    }
    const id = tripInstanceId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    let state = INITIAL_POLL;

    function schedule(delayMs: number): void {
      timer = setTimeout(() => {
        timer = undefined;
        if (pageHidden()) {
          waiting = true;
          return;
        }
        void load();
      }, delayMs);
    }

    async function load(): Promise<void> {
      const fetcher = fetchRef.current ?? ((input, init) => globalThis.fetch(input, init));
      const result = await fetchTrainDetail(id, {
        fetch: fetcher,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        etag: state.etag,
        signal: controller.signal,
      }).catch(() => null);
      if (result === null || controller.signal.aborted) {
        return;
      }
      const step = pollStep(result, state, (clockRef.current ?? Date.now)());
      state = step.state;
      setSnapshot((previous) =>
        previous.id === id &&
        previous.attempt === attempt &&
        sameSnapshot(previous.value, step.snapshot)
          ? previous
          : { id, attempt, value: step.snapshot },
      );
      if (step.again) {
        schedule(nextPollDelay(refreshMs, state.failures));
      }
    }

    function onVisibility(): void {
      if (!pageHidden() && waiting) {
        waiting = false;
        void load();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tripInstanceId, baseUrl, refreshMs, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (tripInstanceId === null) {
    return { status: "idle" };
  }
  if (snapshot.id !== tripInstanceId || snapshot.attempt !== attempt) {
    return { status: "loading" };
  }
  const value = snapshot.value;
  return value.status === "error" || value.status === "not-found" ? { ...value, retry } : value;
}
