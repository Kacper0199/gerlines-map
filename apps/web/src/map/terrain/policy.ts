import type { GpuTier } from "./gpu-tier.ts";

export const TERRAIN_STORAGE_KEY = "gerlines-terrain-3d";
export const BUILDINGS_STORAGE_KEY = "gerlines-buildings-3d";

export interface TierDefaults {
  /** Whether the Terrain style draws its relief in 3D until the user switches it. */
  readonly terrain3d: boolean;
  /** Whether buildings are extruded from zoom 14.5 until the user switches them. */
  readonly buildings: boolean;
}

const DEFAULTS: Readonly<Record<GpuTier, TierDefaults>> = {
  low: { terrain3d: false, buildings: false },
  mid: { terrain3d: true, buildings: false },
  high: { terrain3d: true, buildings: true },
};

export function tierDefaults(tier: GpuTier): TierDefaults {
  return DEFAULTS[tier];
}

export function readToggle(storage: Pick<Storage, "getItem">, key: string): boolean | null {
  try {
    const value = storage.getItem(key);
    if (value === "on") return true;
    return value === "off" ? false : null;
  } catch {
    return null;
  }
}

export function storeToggle(storage: Pick<Storage, "setItem">, key: string, on: boolean): void {
  try {
    storage.setItem(key, on ? "on" : "off");
  } catch {
    return;
  }
}

export function initialTerrain3d(tier: GpuTier, storage: Pick<Storage, "getItem">): boolean {
  return readToggle(storage, TERRAIN_STORAGE_KEY) ?? tierDefaults(tier).terrain3d;
}

export function initialBuildings(tier: GpuTier, storage: Pick<Storage, "getItem">): boolean {
  return readToggle(storage, BUILDINGS_STORAGE_KEY) ?? tierDefaults(tier).buildings;
}
