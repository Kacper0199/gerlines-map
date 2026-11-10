import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "../motion/categories.ts";
import type { NearestRequest, NearestTrains, NearTrain } from "../motion/protocol.ts";
import { latOf, lonOf } from "./geometry.ts";
import { liveTrainId } from "./train-ids.ts";

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS = Math.PI / 180;

export interface NearestEntry {
  readonly key: number;
  readonly slot: number;
  readonly category: CategoryKey;
  readonly operatorGroup?: OperatorGroup;
  readonly trip: {
    readonly line: string | null;
    readonly trainNumber: number | null;
    readonly foreign: boolean;
    readonly delay: number | null;
  };
}

export interface NearestFleet {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly alive: ArrayLike<number>;
  readonly alpha: ArrayLike<number>;
}

function groundDistanceM(lonA: number, latA: number, lonB: number, latB: number): number {
  const dLat = (latB - latA) * RADIANS;
  const dLon = (lonB - lonA) * RADIANS;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * RADIANS) * Math.cos(latB * RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The shown trains nearest a point and how many shown trains lie in the view, the text path to the map (WCAG 1.1.1):
 * a train that is hidden by a legend filter, gone or faded out is not listed, as it is not drawn.
 */
function insideArea(lon: number, lat: number, area: readonly (readonly [number, number])[]) {
  let inside = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const [xi, yi] = area[i] as readonly [number, number];
    const [xj, yj] = area[j] as readonly [number, number];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function nearestTrains<E extends NearestEntry>(
  entries: Iterable<E>,
  fleet: NearestFleet,
  request: NearestRequest,
  isShown: (entry: E) => boolean,
): NearestTrains {
  const area = request.area;
  const found: NearTrain[] = [];
  let inView = 0;
  for (const entry of entries) {
    const slot = entry.slot;
    if (!fleet.alive[slot] || (fleet.alpha[slot] as number) <= 0 || !isShown(entry)) continue;
    const lon = lonOf(fleet.x[slot] as number);
    const lat = latOf(fleet.y[slot] as number);
    if (area && !insideArea(lon, lat, area)) continue;
    inView++;
    found.push({
      key: entry.key,
      id: liveTrainId(entry.key),
      line: entry.trip.line,
      trainNumber: entry.trip.trainNumber,
      category: entry.category,
      foreign: entry.trip.foreign,
      delaySeconds: entry.trip.delay,
      lon,
      lat,
      distanceM: groundDistanceM(request.lon, request.lat, lon, lat),
    });
  }
  found.sort((a, b) => a.distanceM - b.distanceM || a.key - b.key);
  return { inView, trains: found.slice(0, request.count) };
}
