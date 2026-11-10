import { describe, expect, it } from "vitest";
import { contrastRatio, tokenContrast } from "./contrast.ts";
import type { ColorName, ThemeName } from "./tokens.ts";

describe("contrastRatio", () => {
  it("returns 21 for black on white and 1 for identical colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#17181A", "#17181A")).toBeCloseTo(1, 5);
  });

  it("rejects text that is not a six digit hex colour", () => {
    expect(() => contrastRatio("#fff", "#000000")).toThrow(TypeError);
  });
});

const TEXT_PAIRS: readonly [ColorName, ColorName, number][] = [
  ["ink", "surface", 4.5],
  ["ink-muted", "surface", 4.5],
  ["ink-muted", "neutral", 4.5],
  ["on-primary", "primary", 4.5],
  ["primary-text", "surface", 4.5],
  ["map-label", "map-land", 4.5],
  ["map-label-city", "map-land", 4.5],
];

const UI_PAIRS: readonly [ColorName, ColorName, number][] = [
  ["passed", "surface", 3],
  ["focus", "surface", 3],
  ["error", "surface", 3],
  ["error", "neutral", 3],
];

describe.each(["dark", "light"] as ThemeName[])("%s theme contrast", (theme) => {
  it.each(TEXT_PAIRS)("%s on %s reaches %s for text", (foreground, background, minimum) => {
    expect(tokenContrast(foreground, background, theme)).toBeGreaterThanOrEqual(minimum);
  });

  it.each(UI_PAIRS)(
    "%s on %s reaches %s for interface parts",
    (foreground, background, minimum) => {
      expect(tokenContrast(foreground, background, theme)).toBeGreaterThanOrEqual(minimum);
    },
  );
});

describe("DESIGN.md computed contrast claims", () => {
  it("matches the dark ink, muted and amber figures", () => {
    expect(tokenContrast("ink", "surface", "dark")).toBeCloseTo(15.5, 0);
    expect(tokenContrast("ink-muted", "surface", "dark")).toBeCloseTo(6.6, 0);
    expect(tokenContrast("primary", "surface", "dark")).toBeCloseTo(9.7, 0);
  });

  it("matches the light ink and selection text figures", () => {
    expect(tokenContrast("ink", "surface", "light")).toBeCloseTo(16.7, 0);
    expect(tokenContrast("primary-text", "surface", "light")).toBeCloseTo(4.7, 0);
  });
});
