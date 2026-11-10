import { colorValue, hexToRgb, type ThemeName } from "../../theme/tokens.ts";
import { type MapStyleKind, themeForStyle } from "./map-styles.ts";

export interface MapPalette {
  readonly land: string;
  readonly water: string;
  readonly sea: string | null;
  readonly seaGround: string | null;
  readonly rail: string;
  readonly label: string;
  readonly labelCity: string;
  readonly labelWater: string;
  readonly halo: string;
  readonly landTint: string;
  readonly greenTint: string;
  readonly building: string;
  readonly buildingOutline: string;
  readonly roadMinor: string;
  readonly roadMajorCasing: string;
  readonly roadMajor: string;
  readonly roadMotorwayCasing: string;
  readonly roadMotorway: string;
  readonly mask: string;
  readonly maskOpacity: number;
  readonly outline: string;
  readonly germanyOutline: string;
  readonly neighbourLineOpacity: number;
  readonly focusOutline: string;
  readonly boundaryState: string;
  readonly boundaryCountry: string;
}

export interface SatelliteTreatment {
  readonly brightnessMax: number;
  readonly saturation: number;
  readonly contrast: number;
}

export interface HillshadePalette {
  readonly shadowLowZoom: string;
  readonly shadow: string;
  readonly highlight: string;
  readonly accent: string;
  readonly exaggerationLowZoom: number;
  readonly exaggeration: number;
}

const MASK_OPACITY: Readonly<Record<MapStyleKind, number>> = {
  dark: 0.55,
  light: 0.34,
  satellite: 0.62,
  terrain: 0.34,
};

export const SATELLITE_TREATMENT: SatelliteTreatment = {
  brightnessMax: 0.62,
  saturation: -0.35,
  contrast: 0.08,
};

export const TERRAIN_EXAGGERATION = 1.5;

function beneathMask(seen: string, mask: string, opacity: number): string {
  const [target, cover] = [hexToRgb(seen), hexToRgb(mask)];
  const channels = target.map((value, at) => {
    const base = (value - opacity * (cover[at] as number)) / (1 - opacity);
    return Math.min(255, Math.max(0, Math.round(base)))
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("").toUpperCase()}`;
}

export function mapPalette(style: MapStyleKind): MapPalette {
  const theme: ThemeName = themeForStyle(style);
  const color = (name: Parameters<typeof colorValue>[0]) => colorValue(name, theme);
  const satellite = style === "satellite";
  const sea = satellite ? null : color("map-sea");
  return {
    land: color("map-land"),
    water: color("map-water"),
    sea,
    seaGround: sea === null ? null : beneathMask(sea, color("map-mask"), MASK_OPACITY[style]),
    rail: satellite ? color("map-rail-satellite") : color("map-rail"),
    label: satellite ? color("map-label-city") : color("map-label"),
    labelCity: satellite ? color("ink-muted") : color("map-label-city"),
    labelWater: color("map-label-water"),
    halo: color("map-land"),
    landTint: color("map-land-tint"),
    greenTint: color("map-green"),
    building: color("map-building"),
    buildingOutline: color("map-building-outline"),
    roadMinor: color("map-road-minor"),
    roadMajorCasing: color("map-road-major-casing"),
    roadMajor: color("map-road-major"),
    roadMotorwayCasing: color("map-road-motorway-casing"),
    roadMotorway: color("map-road-motorway"),
    mask: color("map-mask"),
    maskOpacity: MASK_OPACITY[style],
    outline: color("map-outline"),
    germanyOutline: satellite ? color("map-rail-satellite") : color("map-outline"),
    neighbourLineOpacity: satellite ? 0.7 : 1,
    focusOutline: color("ink"),
    boundaryState: satellite ? color("map-outline") : color("map-boundary-state"),
    boundaryCountry: satellite ? color("map-boundary-satellite") : color("map-boundary-country"),
  };
}

export function hillshadePalette(style: MapStyleKind): HillshadePalette {
  const theme = themeForStyle(style);
  return {
    shadowLowZoom: colorValue("ink", theme),
    shadow: colorValue("map-label", theme),
    highlight: colorValue("surface", theme),
    accent: colorValue("map-outline", theme),
    exaggerationLowZoom: 1,
    exaggeration: 0.6,
  };
}
