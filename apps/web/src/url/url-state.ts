import { TRAIN_PARAM } from "../components/train/card/share.ts";
import { isLandCode, type LandCode } from "../map/style/map-styles.ts";
import type { Camera } from "../state/place-store.ts";

export const URL_PARAMS = {
  train: TRAIN_PARAM,
  station: "station",
  land: "land",
  map: "map",
} as const;

/** The view and selection a link holds, next to the visit settings it leaves alone (lang, theme). */
export interface UrlView {
  readonly train: string | null;
  readonly station: string | null;
  readonly land: LandCode | null;
  readonly camera: Camera | null;
}

export const EMPTY_VIEW: UrlView = { train: null, station: null, land: null, camera: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_ZOOM = 3.5;
const MAX_ZOOM = 17;

function uuidOf(value: string | null): string | null {
  const lower = value?.trim().toLowerCase() ?? null;
  return lower !== null && UUID.test(lower) ? lower : null;
}

/** `map=<zoom>,<lat>,<lon>`; anything out of range or malformed reads as no camera. */
export function parseCamera(value: string | null): Camera | null {
  const parts = value?.split(",").map((part) => part.trim()) ?? [];
  if (parts.length !== 3 || parts.some((part) => !/^-?\d+(\.\d+)?$/.test(part))) return null;
  const [zoom, lat, lon] = parts.map(Number) as [number, number, number];
  const valid = zoom >= MIN_ZOOM && zoom <= MAX_ZOOM && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
  return valid ? { zoom, lat, lon } : null;
}

export function formatCamera(camera: Camera): string {
  return `${camera.zoom.toFixed(2)},${camera.lat.toFixed(5)},${camera.lon.toFixed(5)}`;
}

export function parseUrlView(search: string): UrlView {
  const params = new URLSearchParams(search);
  const land = params.get(URL_PARAMS.land)?.toUpperCase() ?? null;
  const train = uuidOf(params.get(URL_PARAMS.train));
  return {
    train,
    station: train === null ? uuidOf(params.get(URL_PARAMS.station)) : null,
    land: isLandCode(land) ? land : null,
    camera: parseCamera(params.get(URL_PARAMS.map)),
  };
}

/** The address search with this view written in; every other parameter stays as it was. */
export function writeUrlView(search: string, view: UrlView): string {
  const params = new URLSearchParams(search);
  for (const name of Object.values(URL_PARAMS)) params.delete(name);
  if (view.train !== null) params.set(URL_PARAMS.train, view.train);
  else if (view.station !== null) params.set(URL_PARAMS.station, view.station);
  if (view.land !== null) params.set(URL_PARAMS.land, view.land);
  const rest = params.toString();
  const map = view.camera === null ? "" : `${URL_PARAMS.map}=${formatCamera(view.camera)}`;
  const query = [rest, map].filter((part) => part !== "").join("&");
  return query === "" ? "" : `?${query}`;
}

export function sameSelection(a: UrlView, b: UrlView): boolean {
  return a.train === b.train && a.station === b.station && a.land === b.land;
}
