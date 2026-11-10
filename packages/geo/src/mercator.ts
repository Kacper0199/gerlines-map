export const WEB_MERCATOR_RADIUS = 6378137;

const WGS84_SEMI_MAJOR_AXIS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const DEGREES_TO_RADIANS = Math.PI / 180;

export interface MercatorPoint {
  readonly x: number;
  readonly y: number;
}

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

/** EPSG:3857 easting and northing in metres for WGS84 longitude and latitude in degrees. */
export function lonLatToMercator(lon: number, lat: number): MercatorPoint {
  const phi = lat * DEGREES_TO_RADIANS;
  return {
    x: WEB_MERCATOR_RADIUS * lon * DEGREES_TO_RADIANS,
    y: WEB_MERCATOR_RADIUS * Math.atanh(Math.sin(phi)),
  };
}

export function mercatorToLonLat(x: number, y: number): LonLat {
  return {
    lon: x / WEB_MERCATOR_RADIUS / DEGREES_TO_RADIANS,
    lat: latitudeFromMercatorY(y) / DEGREES_TO_RADIANS,
  };
}

/** Geodetic latitude in radians for an EPSG:3857 northing in metres. */
export function latitudeFromMercatorY(y: number): number {
  return Math.atan(Math.sinh(y / WEB_MERCATOR_RADIUS));
}

/**
 * Ground distance in metres on the WGS84 ellipsoid between two nearby EPSG:3857 points.
 *
 * Uses the local metric at the midpoint: Web Mercator applies the spherical formulas to geodetic
 * coordinates, so dE = N cos(phi) dx / R and dN = M cos(phi) dy / R with the ellipsoid radii of
 * curvature M (meridian) and N (prime vertical). Accurate to better than 1e-6 relative for segments
 * up to a few kilometres; use it per polyline segment, not across a country.
 */
export function groundDistance(x0: number, y0: number, x1: number, y1: number): number {
  const phi = latitudeFromMercatorY((y0 + y1) / 2);
  const sinPhi = Math.sin(phi);
  const w2 = 1 - WGS84_ECCENTRICITY_SQUARED * sinPhi * sinPhi;
  const primeVertical = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(w2);
  const meridian =
    (WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_ECCENTRICITY_SQUARED)) / (w2 * Math.sqrt(w2));
  const scale = Math.cos(phi) / WEB_MERCATOR_RADIUS;
  return scale * Math.hypot(primeVertical * (x1 - x0), meridian * (y1 - y0));
}
