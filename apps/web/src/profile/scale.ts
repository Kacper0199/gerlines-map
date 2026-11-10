import type { ThemeName } from "../theme/tokens.ts";

/** Whole minutes of difference at which the scale stops growing: seven classes, three on each side. */
export const GAIN_CLASS_LIMIT = 3;

export type GainClass = -3 | -2 | -1 | 0 | 1 | 2 | 3;

export const GAIN_CLASSES: readonly GainClass[] = [-3, -2, -1, 0, 1, 2, 3];

/** The curtain stops growing here: minutes lost on one segment. */
export const CURTAIN_CAP_MINUTES = 10;

/**
 * Diverging around zero: blue where this train loses less time on a segment than all trains do, grey where it
 * is the same, red where it loses more. The API gives whole minutes, so the classes are whole minutes.
 * Every colour keeps 3 to 1 against the card surface, the casing the route is drawn on.
 */
const COLOURS: Readonly<Record<ThemeName, Readonly<Record<GainClass, string>>>> = {
  light: {
    "-3": "#104281",
    "-2": "#2a64b8",
    "-1": "#5b93d8",
    "0": "#8f8b81",
    "1": "#e0715e",
    "2": "#c2412c",
    "3": "#8e1f14",
  },
  dark: {
    "-3": "#6aa8ff",
    "-2": "#4e8de0",
    "-1": "#3d6fb0",
    "0": "#77746e",
    "1": "#b8594c",
    "2": "#e0705f",
    "3": "#ff8e7a",
  },
};

/** Segments without figures: a dashed grey, never one of the scale colours. */
export const MISSING_COLOUR: Readonly<Record<ThemeName, string>> = {
  light: "#6f6b63",
  dark: "#8d8a84",
};

export function profileColour(gain: GainClass, theme: ThemeName): string {
  return COLOURS[theme][gain];
}

export function gainClass(differenceMinutes: number): GainClass {
  const rounded = Math.round(differenceMinutes);
  const clamped = Math.max(-GAIN_CLASS_LIMIT, Math.min(GAIN_CLASS_LIMIT, rounded));
  return (clamped === 0 ? 0 : clamped) as GainClass;
}

export function curtainMinutes(gainSeconds: number): number {
  return Math.max(0, Math.min(CURTAIN_CAP_MINUTES, gainSeconds / 60));
}
