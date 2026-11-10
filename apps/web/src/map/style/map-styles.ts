import type { MapStyleKind } from "@gerlines/ui";
import type { ThemeName } from "../../theme/tokens.ts";

export type { MapStyleKind };

export const MAP_STYLES: readonly MapStyleKind[] = ["dark", "light", "satellite", "terrain"];

const THEME_OF_STYLE: Readonly<Record<MapStyleKind, ThemeName>> = {
  dark: "dark",
  light: "light",
  satellite: "dark",
  terrain: "light",
};

export function isMapStyle(value: unknown): value is MapStyleKind {
  return typeof value === "string" && (MAP_STYLES as readonly string[]).includes(value);
}

export function themeForStyle(style: MapStyleKind): ThemeName {
  return THEME_OF_STYLE[style];
}

export const LAND_CODES = [
  "DE-BB",
  "DE-BE",
  "DE-BW",
  "DE-BY",
  "DE-HB",
  "DE-HE",
  "DE-HH",
  "DE-MV",
  "DE-NI",
  "DE-NW",
  "DE-RP",
  "DE-SH",
  "DE-SL",
  "DE-SN",
  "DE-ST",
  "DE-TH",
] as const;

export type LandCode = (typeof LAND_CODES)[number];

export function isLandCode(value: unknown): value is LandCode {
  return typeof value === "string" && (LAND_CODES as readonly string[]).includes(value);
}
