export interface LngLatLike {
  readonly lng: number;
  readonly lat: number;
}

export interface Box {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export const GERMANY_BOX: Box = { west: 5.866, south: 47.27, east: 15.042, north: 55.059 };
export const ELASTIC_MARGIN_KM = 60;
export const HARD_MARGIN_KM = 400;
export const ELASTIC_LIMIT_KM = 200;

const KM_PER_DEGREE_LAT = 110.574;
const KM_PER_DEGREE_LON_EQUATOR = 111.32;

export function kmPerDegreeLon(lat: number): number {
  return KM_PER_DEGREE_LON_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

export function expandBox(box: Box, km: number): Box {
  const narrowest = kmPerDegreeLon(Math.max(Math.abs(box.south), Math.abs(box.north)));
  return {
    west: box.west - km / narrowest,
    south: box.south - km / KM_PER_DEGREE_LAT,
    east: box.east + km / narrowest,
    north: box.north + km / KM_PER_DEGREE_LAT,
  };
}

export function elasticBox(): Box {
  return expandBox(GERMANY_BOX, ELASTIC_MARGIN_KM);
}

export interface ViewSize {
  readonly width: number;
  readonly height: number;
  readonly padding: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
}

const TILE_SIZE = 512;
const WIDE_VIEW_SLACK = 1.15;
const TALL_VIEW_SLACK = 1.01;

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
}

export function fitZoom(box: Box, view: ViewSize): number {
  const width = Math.max(1, view.width - view.padding.left - view.padding.right);
  const height = Math.max(1, view.height - view.padding.top - view.padding.bottom);
  const spanX = (box.east - box.west) / 360;
  const spanY = mercatorY(box.north) - mercatorY(box.south);
  return Math.log2(Math.min(width / (TILE_SIZE * spanX), height / (TILE_SIZE * spanY)));
}

export function visibleLonSpan(width: number, zoom: number): number {
  return (width * 360) / (TILE_SIZE * 2 ** zoom);
}

const MAX_MERCATOR_LATITUDE = 85.0511;

function latitudeOf(mercator: number): number {
  const latitude =
    ((2 * Math.atan(Math.exp(2 * Math.PI * mercator)) - Math.PI / 2) * 180) / Math.PI;
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function visibleMercatorSpan(height: number, zoom: number): number {
  return height / (TILE_SIZE * 2 ** zoom);
}

export function hardBounds(view?: ViewSize): [[number, number], [number, number]] {
  const hard = expandBox(GERMANY_BOX, HARD_MARGIN_KM);
  if (!view) {
    return [
      [hard.west, hard.south],
      [hard.east, hard.north],
    ];
  }
  const zoom = fitZoom(GERMANY_BOX, view);
  const worldPx = TILE_SIZE * 2 ** zoom;
  let { west, east, south, north } = hard;
  const neededLon = visibleLonSpan(view.width, zoom) * WIDE_VIEW_SLACK;
  const centreLon =
    (GERMANY_BOX.west + GERMANY_BOX.east) / 2 -
    (((view.padding.left - view.padding.right) / 2) * 360) / worldPx;
  if (neededLon > east - west) {
    const middle = (west + east) / 2;
    west = middle - neededLon / 2;
    east = middle + neededLon / 2;
  }
  west = Math.min(west, centreLon - neededLon / 2);
  east = Math.max(east, centreLon + neededLon / 2);
  const southY = mercatorY(south);
  const northY = mercatorY(north);
  const neededY = visibleMercatorSpan(view.height, zoom) * TALL_VIEW_SLACK;
  const centreY =
    (mercatorY(GERMANY_BOX.south) + mercatorY(GERMANY_BOX.north)) / 2 +
    (view.padding.top - view.padding.bottom) / 2 / worldPx;
  let lowY = southY;
  let highY = northY;
  if (neededY > northY - southY) {
    const middleY = (southY + northY) / 2;
    lowY = middleY - neededY / 2;
    highY = middleY + neededY / 2;
  }
  lowY = Math.min(lowY, centreY - neededY / 2);
  highY = Math.max(highY, centreY + neededY / 2);
  south = lowY === southY ? south : latitudeOf(lowY);
  north = highY === northY ? north : latitudeOf(highY);
  return [
    [west, south],
    [east, north],
  ];
}

export function unionBounds(
  a: readonly [readonly [number, number], readonly [number, number]],
  b: readonly [readonly [number, number], readonly [number, number]],
): [[number, number], [number, number]] {
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])],
  ];
}

function beyond(value: number, low: number, high: number): number {
  if (value < low) {
    return value - low;
  }
  if (value > high) {
    return value - high;
  }
  return 0;
}

function lonScale(lat: number, box: Box): number {
  return kmPerDegreeLon(Math.min(Math.max(lat, box.south), box.north));
}

export function overshootKm(center: LngLatLike, box: Box): { x: number; y: number } {
  return {
    x: beyond(center.lng, box.west, box.east) * lonScale(center.lat, box),
    y: beyond(center.lat, box.south, box.north) * KM_PER_DEGREE_LAT,
  };
}

export function rubberBand(rawKm: number, limitKm: number): number {
  return (limitKm * rawKm) / (rawKm + limitKm);
}

export function rubberBandInverse(shownKm: number, limitKm: number): number {
  return (limitKm * shownKm) / (limitKm - shownKm);
}

export function softPosition(
  raw: LngLatLike,
  box: Box,
  limitKm: number = ELASTIC_LIMIT_KM,
): LngLatLike {
  const { x, y } = overshootKm(raw, box);
  const shownY = Math.sign(y) * rubberBand(Math.abs(y), limitKm);
  const lat = y === 0 ? raw.lat : (y > 0 ? box.north : box.south) + shownY / KM_PER_DEGREE_LAT;
  const shownX = Math.sign(x) * rubberBand(Math.abs(x), limitKm);
  const lng = x === 0 ? raw.lng : (x > 0 ? box.east : box.west) + shownX / lonScale(raw.lat, box);
  return { lng, lat };
}

export function rawPosition(
  shown: LngLatLike,
  box: Box,
  limitKm: number = ELASTIC_LIMIT_KM,
): LngLatLike {
  const { x, y } = overshootKm(shown, box);
  const cap = limitKm * 0.999_999;
  const rawY = Math.sign(y) * rubberBandInverse(Math.min(Math.abs(y), cap), limitKm);
  const lat = y === 0 ? shown.lat : (y > 0 ? box.north : box.south) + rawY / KM_PER_DEGREE_LAT;
  const rawX = Math.sign(x) * rubberBandInverse(Math.min(Math.abs(x), cap), limitKm);
  const lng = x === 0 ? shown.lng : (x > 0 ? box.east : box.west) + rawX / lonScale(shown.lat, box);
  return { lng, lat };
}

export interface GestureStart {
  readonly widen?: boolean;
  readonly keep?: readonly LngLatLike[];
}

export interface ElasticTracker {
  start(center: LngLatLike, options?: GestureStart): Box;
  next(requested: LngLatLike): LngLatLike;
}

export function includePoints(box: Box, points: readonly LngLatLike[]): Box {
  return points.reduce<Box>(
    (grown, point) => ({
      west: Math.min(grown.west, point.lng),
      south: Math.min(grown.south, point.lat),
      east: Math.max(grown.east, point.lng),
      north: Math.max(grown.north, point.lat),
    }),
    box,
  );
}

export function createElasticTracker(box: Box, limitKm: number = ELASTIC_LIMIT_KM): ElasticTracker {
  let gestureBox = box;
  let offset = { lng: 0, lat: 0 };
  return {
    start(center, { widen = true, keep = [] } = {}) {
      const kept = includePoints(box, keep);
      const { x, y } = overshootKm(center, kept);
      const showable = Math.max(Math.abs(x), Math.abs(y)) < limitKm * 0.99;
      gestureBox = widen || !showable ? includePoints(kept, [center]) : kept;
      const raw = rawPosition(center, gestureBox, limitKm);
      offset = { lng: raw.lng - center.lng, lat: raw.lat - center.lat };
      return gestureBox;
    },
    next(requested) {
      return softPosition(
        { lng: requested.lng + offset.lng, lat: requested.lat + offset.lat },
        gestureBox,
        limitKm,
      );
    },
  };
}

export function releaseTarget(
  center: LngLatLike,
  gestureBox: Box,
  box: Box,
  selected: LngLatLike | null,
): LngLatLike | null {
  if (selected && isOutside(selected, box)) {
    return null;
  }
  return isOutside(center, gestureBox) ? clampToBox(center, gestureBox) : null;
}

export function clampToBox(center: LngLatLike, box: Box): LngLatLike {
  return {
    lng: Math.min(Math.max(center.lng, box.west), box.east),
    lat: Math.min(Math.max(center.lat, box.south), box.north),
  };
}

export function isOutside(center: LngLatLike, box: Box): boolean {
  const { x, y } = overshootKm(center, box);
  return x !== 0 || y !== 0;
}
