import { describe, expect, it } from "vitest";
import {
  initialMapStyle,
  initialTheme,
  MAP_STYLE_STORAGE_KEY,
  readStoredStyle,
  readStoredTheme,
  storeMapStyle,
  storeTheme,
  styleFromSearch,
  THEME_STORAGE_KEY,
  themeFromSearch,
} from "./preference.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const BROKEN = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("themeFromSearch", () => {
  it("reads a theme the address asks for and ignores anything else", () => {
    expect(themeFromSearch("?theme=light")).toBe("light");
    expect(themeFromSearch("?theme=dark")).toBe("dark");
    expect(themeFromSearch("?theme=sepia")).toBeUndefined();
    expect(themeFromSearch("")).toBeUndefined();
  });
});

describe("stored theme", () => {
  it("round trips the choice through storage", () => {
    const storage = memoryStorage();

    storeTheme(storage, "light");

    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme(storage)).toBe("light");
  });

  it("ignores a stored value that is not a theme", () => {
    expect(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBeUndefined();
  });

  it("survives storage that throws", () => {
    expect(readStoredTheme(BROKEN)).toBeUndefined();
    expect(() => storeTheme(BROKEN, "dark")).not.toThrow();
  });
});

describe("initialTheme", () => {
  it("is dark by default", () => {
    expect(initialTheme("", memoryStorage())).toBe("dark");
  });

  it("lets the address win over the stored choice", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });

    expect(initialTheme("?theme=dark", storage)).toBe("dark");
    expect(initialTheme("", storage)).toBe("light");
  });
});

describe("map style preference", () => {
  it("reads a style the address asks for and ignores anything else", () => {
    expect(styleFromSearch("?style=terrain")).toBe("terrain");
    expect(styleFromSearch("?style=satellite&theme=light")).toBe("satellite");
    expect(styleFromSearch("?style=topo")).toBeUndefined();
  });

  it("stores the style together with the theme it brings", () => {
    const storage = memoryStorage();

    storeMapStyle(storage, "terrain");

    expect(storage.getItem(MAP_STYLE_STORAGE_KEY)).toBe("terrain");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredStyle(storage)).toBe("terrain");
    expect(() => storeMapStyle(BROKEN, "dark")).not.toThrow();
    expect(readStoredStyle(BROKEN)).toBeUndefined();
  });

  it("starts with the address style, then the address theme, then the stored style, then the stored theme", () => {
    const stored = memoryStorage({
      [MAP_STYLE_STORAGE_KEY]: "satellite",
      [THEME_STORAGE_KEY]: "dark",
    });

    expect(initialMapStyle("?style=terrain&theme=dark", stored)).toBe("terrain");
    expect(initialMapStyle("?theme=light", stored)).toBe("light");
    expect(initialMapStyle("", stored)).toBe("satellite");
    expect(initialMapStyle("", memoryStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
    expect(initialMapStyle("", memoryStorage())).toBe("dark");
  });

  it("derives the interface theme from the map style", () => {
    expect(initialTheme("?style=terrain", memoryStorage())).toBe("light");
    expect(initialTheme("?style=satellite", memoryStorage())).toBe("dark");
  });
});
