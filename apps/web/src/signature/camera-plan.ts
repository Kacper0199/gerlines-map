import { SELECT_MIN_ZOOM, SELECT_PITCH, TILT_MAX_PITCH } from "../map/camera-constants.ts";
import type { ViewPadding } from "../map/view-padding.ts";

export const FLIGHT_MIN_MS = 700;
export const FLIGHT_MAX_MS = 1400;
/** A train further than this many screens away is reached on an arc that zooms out and in. */
const FLY_FROM_SCREENS = 1.2;
const FLY_CURVE = 1.3;
const FLY_MIN_ZOOM = 4;
const MS_PER_DOUBLING = 260;
const MS_PER_ZOOM_LEVEL = 50;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_PX = 512;
const CHASE_SHIFT = 0.2;
const CHASE_MIN_PITCH = 20;
const FREE_HEIGHT_MIN = 0.3;

export interface CameraState {
  readonly lng: number;
  readonly lat: number;
  readonly zoom: number;
  readonly pitch: number;
}

export interface FlightPlan {
  readonly mode: "cut" | "ease" | "fly";
  readonly zoom: number;
  readonly pitch: number;
  readonly durationMs: number;
  readonly curve: number;
  readonly minZoom: number;
}

export interface PlanOptions {
  readonly reducedMotion: boolean;
  readonly tilt: boolean;
  readonly maxZoom: number;
}

export function metresPerPixel(zoom: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
}

function distanceMetres(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  const midLat = ((from.lat + to.lat) / 2) * (Math.PI / 180);
  const dx = (to.lng - from.lng) * Math.cos(midLat);
  const dy = to.lat - from.lat;
  return Math.hypot(dx, dy) * 111_195;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The camera move of a selection: fly to the train, close in to at least the selection zoom and tilt. The time
 * grows with the distance in screens at the closer of the two zooms (log), because a cross-country flight needs time to read and a hop within
 * the view must not drag; it stays within 0.7 to 1.4 s so the click is answered at once and the moment ends
 * before the card is read. Under reduced motion the move is a cut.
 */
export function planSelection(
  from: CameraState,
  to: { readonly lng: number; readonly lat: number },
  viewport: { readonly width: number; readonly height: number },
  options: PlanOptions,
): FlightPlan {
  const zoom = Math.min(options.maxZoom, Math.max(from.zoom, SELECT_MIN_ZOOM));
  const pitch = options.tilt
    ? Math.min(TILT_MAX_PITCH, Math.max(from.pitch, SELECT_PITCH))
    : from.pitch;
  const base = { zoom, pitch, curve: FLY_CURVE, minZoom: FLY_MIN_ZOOM };
  if (options.reducedMotion) return { ...base, mode: "cut", durationMs: 0 };
  const screens =
    distanceMetres(from, to) /
    (metresPerPixel(Math.max(from.zoom, zoom), from.lat) * Math.max(1, viewport.width));
  const durationMs = Math.round(
    clamp(
      FLIGHT_MIN_MS +
        MS_PER_DOUBLING * Math.log2(1 + screens) +
        MS_PER_ZOOM_LEVEL * Math.abs(zoom - from.zoom),
      FLIGHT_MIN_MS,
      FLIGHT_MAX_MS,
    ),
  );
  return { ...base, mode: screens > FLY_FROM_SCREENS ? "fly" : "ease", durationMs };
}

/**
 * Padding that sits a tilted train off the middle of the free map area, towards the viewer when it runs
 * north and away from the viewer when it runs south, so more of the route ahead stays on screen. The map
 * stays north up, so the shift follows the cosine of the heading.
 */
export function chasePadding(
  padding: ViewPadding,
  bearingDeg: number,
  pitch: number,
  viewportHeight: number,
): ViewPadding {
  if (pitch < CHASE_MIN_PITCH) return padding;
  const north = Math.cos((bearingDeg * Math.PI) / 180);
  const free = viewportHeight - padding.top - padding.bottom;
  const wanted = CHASE_SHIFT * free * Math.abs(north);
  const shift = Math.max(0, Math.min(wanted, free - FREE_HEIGHT_MIN * viewportHeight));
  if (shift < 1) return padding;
  return north > 0
    ? { ...padding, top: padding.top + shift }
    : { ...padding, bottom: padding.bottom + shift };
}

const AT_TARGET_PX = 2;
const AT_TARGET_ZOOM = 0.01;
const AT_TARGET_PITCH = 0.5;
/** From this pitch a map counts as tilted. */
const PITCHED_MIN = 0.5;

export function isPitched(pitch: number): boolean {
  return pitch > PITCHED_MIN;
}

/** Whether the camera already stands where a plan would put it, so a cut would change nothing. */
export function atTarget(
  from: CameraState,
  to: { readonly lng: number; readonly lat: number },
  plan: { readonly zoom: number; readonly pitch: number },
): boolean {
  return (
    distanceMetres(from, to) < AT_TARGET_PX * metresPerPixel(plan.zoom, from.lat) &&
    Math.abs(from.zoom - plan.zoom) < AT_TARGET_ZOOM &&
    Math.abs(from.pitch - plan.pitch) < AT_TARGET_PITCH
  );
}
