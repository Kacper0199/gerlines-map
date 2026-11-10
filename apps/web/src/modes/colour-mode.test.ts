import { afterEach, describe, expect, it, vi } from "vitest";
import { COLOUR_MODES, isColourMode, readColourMode, writeColourMode } from "./colour-mode.ts";

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("colour mode preference", () => {
  it("knows category, delay and operator", () => {
    expect(COLOUR_MODES).toEqual(["category", "delay", "operator"]);
    expect(isColourMode("delay")).toBe(true);
    expect(isColourMode("operator")).toBe(true);
    expect(isColourMode("rainbow")).toBe(false);
  });

  it("falls back to category when nothing or something unknown is stored", () => {
    expect(readColourMode(storage())).toBe("category");
    expect(readColourMode(storage({ "gerlines.colourMode": "rainbow" }))).toBe("category");
  });

  it("round trips through the storage", () => {
    const store = storage();
    writeColourMode("delay", store);
    expect(readColourMode(store)).toBe("delay");
  });

  it("round trips the operator mode", () => {
    const store = storage();
    writeColourMode("operator", store);
    expect(store.data.get("gerlines.colourMode")).toBe("operator");
    expect(readColourMode(store)).toBe("operator");
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readColourMode(broken)).toBe("category");
    expect(() => writeColourMode("delay", broken)).not.toThrow();
  });

  it("uses localStorage by default and reads category without it", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readColourMode()).toBe("category");
  });
});
