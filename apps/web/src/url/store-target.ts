import {
  cachedTripOfKey,
  fetchTripOfKey,
  seedTripOfKey,
  tripCacheGeneration,
} from "../hooks/use-frame-trip.ts";
import { fetchStation } from "../search/search-client.ts";
import { usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";
import type { ApplyStores } from "./apply-view.ts";
import type { SelectionSnapshot, UrlSyncTarget } from "./url-sync.ts";

/** What the address should say about the app and place stores right now. */
export function selectionSnapshot(): SelectionSnapshot {
  const app = useAppStore.getState();
  const place = usePlaceStore.getState();
  const missing = place.missingStation;
  return {
    selectedId: app.selectedId,
    stationId:
      place.pendingStationId ??
      place.station?.id ??
      (missing?.reason === "error" ? missing.id : null),
    missingStationId: missing?.reason === "not-found" ? missing.id : null,
    land: app.focusLand,
  };
}

function sameSnapshot(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return (
    a.selectedId === b.selectedId &&
    a.stationId === b.stationId &&
    a.missingStationId === b.missingStationId &&
    a.land === b.land
  );
}

function subscribeSelection(listener: () => void): () => void {
  let last = selectionSnapshot();
  const changed = () => {
    const next = selectionSnapshot();
    if (sameSnapshot(next, last)) return;
    last = next;
    listener();
  };
  const stopApp = useAppStore.subscribe(changed);
  const stopPlace = usePlaceStore.subscribe(changed);
  return () => {
    stopApp();
    stopPlace();
  };
}

/** The url-sync target over the live stores; `apply` puts an address view into them. */
export function storeTarget(apply: UrlSyncTarget["apply"]): UrlSyncTarget {
  return { snapshot: selectionSnapshot, subscribe: subscribeSelection, apply };
}

const browserFetch = (input: string, init?: RequestInit) => globalThis.fetch(input, init);

const KEY_LOOKUP_TRIES = 2;

/**
 * The trip instance of a frame key from the card's cache (cleared on a timeline epoch change),
 * else looked up and seeded there. An answer that arrives after an epoch change belongs to the old
 * epoch, so it is not seeded and the key is asked again once.
 */
export async function browserTrainOfKey(key: number): Promise<string | null> {
  for (let attempt = 0; attempt < KEY_LOOKUP_TRIES; attempt++) {
    const held = cachedTripOfKey(key);
    if (held !== null) return held;
    const started = tripCacheGeneration();
    const answer = await fetchTripOfKey(key, { fetch: browserFetch });
    if (answer.kind !== "ok") return null;
    if (tripCacheGeneration() !== started) continue;
    seedTripOfKey(key, answer.tripInstanceId);
    return answer.tripInstanceId;
  }
  return null;
}

export function browserApplyStores(): ApplyStores {
  return {
    app: () => useAppStore.getState(),
    place: () => usePlaceStore.getState(),
    knownTrainOfKey: cachedTripOfKey,
    fetchStation,
    fetch: browserFetch,
  };
}
