import { liveKeyOf } from "../live/train-ids.ts";
import { STATION_ZOOM } from "../search/choose.ts";
import type { FetchLike, StationFetch } from "../search/search-client.ts";
import type { PlaceState } from "../state/place-store.ts";
import type { AppState } from "../state/store.ts";
import type { UrlView } from "./url-state.ts";

export interface ApplyStores {
  readonly app: () => Pick<AppState, "selectedId" | "focusLand" | "select" | "setFocusLand">;
  readonly place: () => Pick<
    PlaceState,
    | "station"
    | "pendingStationId"
    | "missingStation"
    | "selectStation"
    | "setPendingStation"
    | "markStationMissing"
    | "requestCamera"
  >;
  readonly knownTrainOfKey: (key: number) => string | null;
  readonly fetchStation: (id: string, options: { fetch: FetchLike }) => Promise<StationFetch>;
  readonly fetch: FetchLike;
}

function selectedTrain(stores: ApplyStores): string | null {
  const id = stores.app().selectedId;
  const key = liveKeyOf(id);
  return key === null ? id : stores.knownTrainOfKey(key);
}

/**
 * Loads a station named by the address into its card. A station the API does not know, or cannot
 * give right now, stays in the store as missing, so the card can say so and offer Try again.
 */
export function loadStation(id: string, { fly }: { fly: boolean }, stores: ApplyStores): void {
  stores.place().setPendingStation(id);
  void stores.fetchStation(id, { fetch: stores.fetch }).then((answer) => {
    const now = stores.place();
    if (now.pendingStationId !== id) return;
    if (answer.kind !== "ok") {
      now.markStationMissing(id, answer.kind === "not-found" ? "not-found" : "error");
      return;
    }
    const { kind: _kind, ...station } = answer.station;
    now.selectStation(station);
    if (fly)
      now.requestCamera({ kind: "point", lon: station.lon, lat: station.lat, zoom: STATION_ZOOM });
  });
}

function applyStation(view: UrlView, cause: "load" | "pop", stores: ApplyStores): void {
  const place = stores.place();
  const id = view.station;
  if (id === null) {
    if (
      place.station !== null ||
      place.pendingStationId !== null ||
      place.missingStation !== null
    ) {
      place.selectStation(null);
    }
    return;
  }
  if (place.station?.id === id || place.pendingStationId === id) return;
  loadStation(id, { fly: cause === "load" && view.camera === null }, stores);
}

/** Puts a view from the address (a link, or Back and Forward) into the stores and the camera. */
export function applyView(view: UrlView, cause: "load" | "pop", stores: ApplyStores): void {
  const app = stores.app();
  if (view.train !== null) {
    stores.place().selectStation(null);
    if (selectedTrain(stores) !== view.train) app.select(view.train);
  } else if (app.selectedId !== null) {
    app.select(null);
  }
  applyStation(view, cause, stores);
  if (app.focusLand !== view.land) app.setFocusLand(view.land);
  if (view.camera !== null) {
    stores.place().requestCamera({ kind: "view", camera: view.camera, animate: cause === "pop" });
  }
}
