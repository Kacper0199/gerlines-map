import type { SearchResult } from "@gerlines/schema/search";
import { isLandCode } from "../map/style/map-styles.ts";
import { type PlaceState, usePlaceStore } from "../state/place-store.ts";
import { type AppState, useAppStore } from "../state/store.ts";

export const STATION_ZOOM = 13.5;
export const TOWN_ZOOM = 11.5;

export interface ChooseStores {
  readonly app: Pick<AppState, "select" | "setFocusLand">;
  readonly place: Pick<PlaceState, "selectStation" | "requestCamera">;
}

function liveStores(): ChooseStores {
  return { app: useAppStore.getState(), place: usePlaceStore.getState() };
}

/**
 * What picking a result does: a train opens its card (the map flies to it once its frame key is
 * known), a station opens the station card and flies there, a line fits its stops, a Land takes the
 * Land focus and a town flies to its centre. One selection holds at a time.
 */
export function chooseResult(result: SearchResult, stores: ChooseStores = liveStores()): void {
  const { app, place } = stores;
  switch (result.kind) {
    case "train":
      place.selectStation(null);
      app.select(result.id);
      return;
    case "station": {
      const { kind: _kind, ...station } = result;
      app.select(null);
      place.selectStation(station);
      place.requestCamera({ kind: "point", lon: result.lon, lat: result.lat, zoom: STATION_ZOOM });
      return;
    }
    case "line":
      app.select(null);
      place.selectStation(null);
      place.requestCamera({ kind: "box", bbox: result.bbox });
      return;
    case "place":
      app.select(null);
      place.selectStation(null);
      if (result.type === "land" && isLandCode(result.landCode)) {
        app.setFocusLand(result.landCode);
        return;
      }
      place.requestCamera({ kind: "point", lon: result.lon, lat: result.lat, zoom: TOWN_ZOOM });
      return;
  }
}
