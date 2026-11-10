export const COLOUR_MODES = ["category", "delay", "operator"] as const;

export type ColourMode = (typeof COLOUR_MODES)[number];

import { type PreferenceStorage, readPreference, writePreference } from "./preference.ts";

export const COLOUR_MODE_KEY = "gerlines.colourMode";

export function isColourMode(value: unknown): value is ColourMode {
  return COLOUR_MODES.includes(value as ColourMode);
}

export function readColourMode(storage?: PreferenceStorage): ColourMode {
  return readPreference(COLOUR_MODE_KEY, isColourMode, "category", storage);
}

export function writeColourMode(mode: ColourMode, storage?: PreferenceStorage): void {
  writePreference(COLOUR_MODE_KEY, mode, storage);
}
