import { readToggle, storeToggle } from "../map/terrain/policy.ts";

export const SELECTION_TILT_STORAGE_KEY = "gerlines-selection-tilt";

export function initialSelectionTilt(storage: Pick<Storage, "getItem">): boolean {
  return readToggle(storage, SELECTION_TILT_STORAGE_KEY) ?? true;
}

export function storeSelectionTilt(storage: Pick<Storage, "setItem">, on: boolean): void {
  storeToggle(storage, SELECTION_TILT_STORAGE_KEY, on);
}
