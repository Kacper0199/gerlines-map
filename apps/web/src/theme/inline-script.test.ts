// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialTheme, MAP_STYLE_STORAGE_KEY, THEME_STORAGE_KEY } from "./preference.ts";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

function themeSetByScript(
  search: string,
  stored: string | null,
  storedStyle: string | null = null,
): string | undefined {
  window.history.replaceState(null, "", `/${search}`);
  window.localStorage.clear();
  if (stored !== null) {
    window.localStorage.setItem(THEME_STORAGE_KEY, stored);
  }
  if (storedStyle !== null) {
    window.localStorage.setItem(MAP_STYLE_STORAGE_KEY, storedStyle);
  }
  delete document.documentElement.dataset.theme;
  new Function(inlineScript)();
  return document.documentElement.dataset.theme;
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("the inline theme script of index.html", () => {
  it("exists and reads the storage key the app writes", () => {
    expect(inlineScript).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  it.each([
    ["", null],
    ["", "light"],
    ["", "dark"],
    ["", "sepia"],
    ["?theme=light", null],
    ["?theme=light", "dark"],
    ["?theme=dark", "light"],
    ["?theme=sepia", "light"],
    ["?theme=sepia", null],
  ] as const)("picks the same theme as the app for %j and stored %j", (search, stored) => {
    const expected = initialTheme(search, {
      getItem: (key) => (key === THEME_STORAGE_KEY ? stored : null),
    });

    expect(themeSetByScript(search, stored)).toBe(expected);
  });

  it.each([
    ["?style=terrain", null, null],
    ["?style=satellite", "light", null],
    ["?style=terrain&theme=dark", null, null],
    ["?style=sepia", "light", null],
    ["", "dark", "terrain"],
    ["", "light", "satellite"],
    ["", "light", "sepia"],
    ["?theme=dark", null, "terrain"],
  ] as const)(
    "follows the map style for %j with stored theme %j and stored style %j",
    (search, stored, storedStyle) => {
      const values: Record<string, string | null> = {
        [THEME_STORAGE_KEY]: stored,
        [MAP_STYLE_STORAGE_KEY]: storedStyle,
      };
      const expected = initialTheme(search, { getItem: (key) => values[key] ?? null });

      expect(themeSetByScript(search, stored, storedStyle)).toBe(expected);
    },
  );

  it("falls back to dark when the storage throws", () => {
    window.history.replaceState(null, "", "/");
    delete document.documentElement.dataset.theme;
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      new Function(inlineScript)();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }

    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
