import { describe, expect, it } from "vitest";
import {
  BUILDINGS_STORAGE_KEY,
  initialBuildings,
  initialTerrain3d,
  readToggle,
  storeToggle,
  TERRAIN_STORAGE_KEY,
  tierDefaults,
} from "./policy.ts";

function memory(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
  };
}

describe("tierDefaults", () => {
  it("starts with the relief on from mid, the buildings only on high, both off on low", () => {
    expect(tierDefaults("low")).toEqual({ terrain3d: false, buildings: false });
    expect(tierDefaults("mid")).toEqual({ terrain3d: true, buildings: false });
    expect(tierDefaults("high")).toEqual({ terrain3d: true, buildings: true });
  });
});

describe("terrain preference", () => {
  it("is unset until the user has chosen", () => {
    expect(readToggle(memory(), TERRAIN_STORAGE_KEY)).toBeNull();
    expect(readToggle(memory({ [TERRAIN_STORAGE_KEY]: "maybe" }), TERRAIN_STORAGE_KEY)).toBeNull();
  });

  it("round-trips the choice", () => {
    const storage = memory();
    storeToggle(storage, TERRAIN_STORAGE_KEY, true);
    expect(readToggle(storage, TERRAIN_STORAGE_KEY)).toBe(true);
    storeToggle(storage, TERRAIN_STORAGE_KEY, false);
    expect(readToggle(storage, TERRAIN_STORAGE_KEY)).toBe(false);
    expect(readToggle(storage, BUILDINGS_STORAGE_KEY)).toBeNull();
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readToggle(broken, TERRAIN_STORAGE_KEY)).toBeNull();
    expect(() => storeToggle(broken, TERRAIN_STORAGE_KEY, true)).not.toThrow();
  });
});

describe("initialTerrain3d", () => {
  it("follows the tier until the user chose, then the choice", () => {
    expect(initialTerrain3d("high", memory())).toBe(true);
    expect(initialTerrain3d("low", memory())).toBe(false);
    expect(initialTerrain3d("low", memory({ [TERRAIN_STORAGE_KEY]: "on" }))).toBe(true);
    expect(initialTerrain3d("high", memory({ [TERRAIN_STORAGE_KEY]: "off" }))).toBe(false);
  });
});

describe("initialBuildings", () => {
  it("follows the tier until the user chose, then the choice", () => {
    expect(initialBuildings("high", memory())).toBe(true);
    expect(initialBuildings("mid", memory())).toBe(false);
    expect(initialBuildings("low", memory())).toBe(false);
    expect(initialBuildings("low", memory({ [BUILDINGS_STORAGE_KEY]: "on" }))).toBe(true);
    expect(initialBuildings("high", memory({ [BUILDINGS_STORAGE_KEY]: "off" }))).toBe(false);
    expect(initialBuildings("low", memory({ [TERRAIN_STORAGE_KEY]: "on" }))).toBe(false);
  });
});
