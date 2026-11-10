import { MINOR_FROM_S } from "./delay.ts";
import { type PreferenceStorage, readPreference, writePreference } from "./preference.ts";

export const LABEL_MODES = ["off", "line", "delay"] as const;

export type LabelMode = (typeof LABEL_MODES)[number];

export const LABEL_MIN_ZOOM = 10.5;

export const LABEL_MODE_KEY = "gerlines.labelMode";

export function isLabelMode(value: unknown): value is LabelMode {
  return LABEL_MODES.includes(value as LabelMode);
}

export function readLabelMode(storage?: PreferenceStorage): LabelMode {
  return readPreference(LABEL_MODE_KEY, isLabelMode, "off", storage);
}

export function writeLabelMode(mode: LabelMode, storage?: PreferenceStorage): void {
  writePreference(LABEL_MODE_KEY, mode, storage);
}

export interface LabelSource {
  readonly line: string | null;
  readonly trainNumber: number | null;
  readonly delay: number | null;
  readonly realtime: boolean;
  readonly foreign: boolean;
}

/** The text drawn beside a train: empty where the data is missing or the train is on time, never a made up value. */
export function labelOf(mode: LabelMode, trip: LabelSource): string {
  if (mode === "line") {
    return trip.line ?? (trip.trainNumber === null ? "" : String(trip.trainNumber));
  }
  if (mode === "delay") {
    if (trip.foreign || !trip.realtime || trip.delay === null || trip.delay < MINOR_FROM_S)
      return "";
    return `+${Math.trunc(trip.delay / 60)}`;
  }
  return "";
}
