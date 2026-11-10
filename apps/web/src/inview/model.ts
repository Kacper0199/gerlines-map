import type { CompassPoint } from "@gerlines/i18n/inview";

const RADIANS = Math.PI / 180;
const POINTS: readonly CompassPoint[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const CENTRE_RADIUS_M = 50;

export interface Place {
  readonly lon: number;
  readonly lat: number;
}

/** Initial compass bearing from one place to another in degrees, 0 north and clockwise. */
export function bearingDegrees(from: Place, to: Place): number {
  const dLon = (to.lon - from.lon) * RADIANS;
  const y = Math.sin(dLon) * Math.cos(to.lat * RADIANS);
  const x =
    Math.cos(from.lat * RADIANS) * Math.sin(to.lat * RADIANS) -
    Math.sin(from.lat * RADIANS) * Math.cos(to.lat * RADIANS) * Math.cos(dLon);
  return (Math.atan2(y, x) / RADIANS + 360) % 360;
}

export function compassPointOf(bearing: number): CompassPoint {
  const turn = ((bearing % 360) + 360) % 360;
  return POINTS[Math.round(turn / 45) % 8] as CompassPoint;
}

export type DistanceParts = { readonly unit: "m" | "km"; readonly value: number } | "centre";

/** A distance as a rounded number with its unit: ten metres under a kilometre, then one decimal, then whole kilometres. */
export function distanceParts(metres: number): DistanceParts {
  if (metres < CENTRE_RADIUS_M) return "centre";
  if (metres < 995) return { unit: "m", value: Math.max(10, Math.round(metres / 10) * 10) };
  const km = metres / 1000;
  return { unit: "km", value: km < 9.95 ? Math.round(km * 10) / 10 : Math.round(km) };
}

interface DistanceCopy {
  readonly metres: (value: string) => string;
  readonly kilometres: (value: string) => string;
  readonly centre: string;
  readonly directions: Readonly<Record<CompassPoint, string>>;
}

/** Where a train lies from the middle of the map in words: "2.3 km to the north-east". */
export function positionText(
  from: Place,
  to: Place & { readonly distanceM: number },
  copy: DistanceCopy,
  locale: string,
): string {
  const parts = distanceParts(to.distanceM);
  if (parts === "centre") return copy.centre;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(parts.value);
  const distance = parts.unit === "m" ? copy.metres(number) : copy.kilometres(number);
  return `${distance} ${copy.directions[compassPointOf(bearingDegrees(from, to))]}`;
}
