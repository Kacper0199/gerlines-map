import { describe, expect, it } from "vitest";
import { hexToRgb, trainPalette } from "./tokens.ts";

describe("hexToRgb", () => {
  it("splits a hex colour into channels", () => {
    expect(hexToRgb("#FFB000")).toEqual([255, 176, 0]);
    expect(hexToRgb("#17181a")).toEqual([23, 24, 26]);
  });

  it("rejects text that is not a six digit hex colour", () => {
    expect(() => hexToRgb("#fff")).toThrow(TypeError);
  });
});

describe("trainPalette", () => {
  it("uses the dark category colours and the dark land colour for the dark theme", () => {
    const palette = trainPalette("dark");

    expect(palette.fill.hsr).toEqual(hexToRgb("#EDE6D6"));
    expect(palette.fill.sbahn).toEqual(hexToRgb("#5FC08A"));
    expect(palette.land).toEqual(hexToRgb("#1A1B1D"));
  });

  it("uses the light category colours for the light theme", () => {
    expect(trainPalette("light").fill.hsr).toEqual(hexToRgb("#26231E"));
  });

  it("gives night trains the high speed colour, drawn hollow by the layers", () => {
    expect(trainPalette("dark").fill.night).toEqual(trainPalette("dark").fill.hsr);
  });

  it("covers every category", () => {
    expect(Object.keys(trainPalette("light").fill).sort()).toEqual([
      "foreign",
      "hsr",
      "ld",
      "night",
      "reg",
      "rfast",
      "sbahn",
    ]);
  });
});
