import { liveKeyPath } from "@gerlines/schema/constants";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { loadTrainSchema } from "../schema-loaders.ts";
import type { FetchLike } from "./use-train-detail.ts";

export type TripLookupFetch =
  | { readonly kind: "ok"; readonly tripInstanceId: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" }
  | { readonly kind: "aborted" };

export type TripLookup =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly tripInstanceId: string }
  | { readonly status: "missing" };

export interface TripLookupOptions {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
}

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const CACHE_LIMIT = 4_000;
const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map<number, { readonly id: string; readonly at: number }>();
let generation = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentGeneration(): number {
  return generation;
}

/** Counts epoch changes; a lookup that started in another generation must not seed the cache. */
export function tripCacheGeneration(): number {
  return generation;
}

function fresh(key: number): string | undefined {
  const entry = cache.get(key);
  return entry !== undefined && Date.now() - entry.at <= CACHE_TTL_MS ? entry.id : undefined;
}

function cached(key: number): string | undefined {
  const known = fresh(key);
  if (known === undefined) cache.delete(key);
  return known;
}

/** The trip instance of a frame key this page already knows, else null (the address uses it). */
export function cachedTripOfKey(key: number): string | null {
  return cached(key) ?? null;
}

/** Remembers a frame key's trip instance (also from a deep link, whose train names its own key). */
export function seedTripOfKey(key: number, tripInstanceId: string): void {
  cache.delete(key);
  cache.set(key, { id: tripInstanceId, at: Date.now() });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Forgets every answer; a lookup that is mounted asks again. */
export function clearTripCache(): void {
  cache.clear();
  generation++;
  for (const listener of listeners) listener();
}

export function nextLookupDelay(failures: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** failures, MAX_RETRY_MS);
}

/** `GET /api/v1/live/keys/{key}`: which trip instance a frame key stands for. */
export async function fetchTripOfKey(
  key: number,
  {
    fetch,
    baseUrl = "",
    signal,
  }: Required<Pick<TripLookupOptions, "fetch">> & { baseUrl?: string; signal?: AbortSignal },
): Promise<TripLookupFetch> {
  const schema = loadTrainSchema().catch(() => null);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${liveKeyPath(key)}`, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return signal?.aborted ? { kind: "aborted" } : { kind: "error" };
  }
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) return { kind: "error" };
  try {
    const loaded = await schema;
    if (loaded === null) return { kind: "error" };
    const parsed = loaded.LiveKeyLookup.safeParse(await response.json());
    return parsed.success
      ? { kind: "ok", tripInstanceId: parsed.data.tripInstanceId }
      : { kind: "error" };
  } catch {
    return signal?.aborted ? { kind: "aborted" } : { kind: "error" };
  }
}

interface Keyed {
  readonly key: number | null;
  readonly generation: number;
  readonly value: TripLookup;
}

/**
 * The trip instance of a frame key, which the train detail is read by. A failure reads as missing
 * at once (the card then shows what the frame knows) and the lookup is asked again after 5 s,
 * doubling up to a minute, since a train that just started may not be known to the detail store yet.
 */
export function useTripOfKey(
  key: number | null,
  { fetch, baseUrl }: TripLookupOptions = {},
): TripLookup {
  const epoch = useSyncExternalStore(subscribe, currentGeneration, currentGeneration);
  const [state, setState] = useState<Keyed>({
    key,
    generation: epoch,
    value: { status: "loading" },
  });
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  useEffect(() => {
    if (key === null) return;
    const hit = cached(key);
    if (hit !== undefined) {
      setState({ key, generation: epoch, value: { status: "ready", tripInstanceId: hit } });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const load = async () => {
      const fetcher = fetchRef.current ?? ((input, init) => globalThis.fetch(input, init));
      const result = await fetchTripOfKey(key, {
        fetch: fetcher,
        signal: controller.signal,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      if (result.kind === "aborted" || controller.signal.aborted) return;
      if (result.kind === "ok") {
        seedTripOfKey(key, result.tripInstanceId);
        setState({
          key,
          generation: epoch,
          value: { status: "ready", tripInstanceId: result.tripInstanceId },
        });
        return;
      }
      setState((previous) =>
        previous.key === key && previous.generation === epoch && previous.value.status === "missing"
          ? previous
          : { key, generation: epoch, value: { status: "missing" } },
      );
      timer = setTimeout(() => void load(), nextLookupDelay(failures++));
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, baseUrl, epoch]);

  if (key === null) return { status: "idle" };
  const known = fresh(key);
  if (known !== undefined) return { status: "ready", tripInstanceId: known };
  return state.key === key && state.generation === epoch ? state.value : { status: "loading" };
}
