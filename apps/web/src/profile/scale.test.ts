import { describe, expect, it } from "vitest";
import { colorValue } from "../theme/tokens.ts";
import {
  CURTAIN_CAP_MINUTES,
  curtainMinutes,
  GAIN_CLASSES,
  gainClass,
  MISSING_COLOUR,
  profileColour,
} from "./scale.ts";

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("gainClass", () => {
  it("rounds the difference to whole minutes and clamps it to three on each side", () => {
    expect(gainClass(0)).toBe(0);
    expect(gainClass(0.4)).toBe(0);
    expect(gainClass(0.6)).toBe(1);
    expect(gainClass(-1.4)).toBe(-1);
    expect(gainClass(-2.6)).toBe(-3);
    expect(gainClass(9)).toBe(3);
    expect(gainClass(-40)).toBe(-3);
  });

  it("does not turn a tiny negative difference into minus zero", () => {
    expect(Object.is(gainClass(-0.2), 0)).toBe(true);
  });
});

describe("curtainMinutes", () => {
  it("is the minutes this train loses, zero where it regains and capped", () => {
    expect(curtainMinutes(180)).toBe(3);
    expect(curtainMinutes(-120)).toBe(0);
    expect(curtainMinutes(0)).toBe(0);
    expect(curtainMinutes(60 * 40)).toBe(CURTAIN_CAP_MINUTES);
  });
});

describe("the diverging colour scale", () => {
  const themes = ["light", "dark"] as const;

  it("has seven classes, blue for less time lost, grey for the same, red for more", () => {
    expect(GAIN_CLASSES).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    for (const theme of themes) {
      const [blue, grey, red] = [-3, 0, 3].map((c) => profileColour(c as -3 | 0 | 3, theme));
      expect(blue).toMatch(/^#[0-9a-f]{6}$/i);
      const channels = (hex: string) =>
        [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const [br, , bb] = channels(blue as string);
      const [rr, , rb] = channels(red as string);
      expect(bb as number).toBeGreaterThan(br as number);
      expect(rr as number).toBeGreaterThan(rb as number);
      const [gr, gg, gb] = channels(grey as string) as [number, number, number];
      expect(Math.max(gr, gg, gb) - Math.min(gr, gg, gb)).toBeLessThan(24);
    }
  });

  it("grows in contrast away from the middle on both arms", () => {
    for (const theme of themes) {
      const surface = colorValue("surface", theme);
      const arm = (classes: readonly (-3 | -2 | -1 | 1 | 2 | 3)[]) =>
        classes.map((c) => contrast(profileColour(c, theme), surface));
      const [blue3, blue2, blue1] = arm([-3, -2, -1]) as [number, number, number];
      const [red1, red2, red3] = arm([1, 2, 3]) as [number, number, number];
      expect(blue3).toBeGreaterThan(blue2);
      expect(blue2).toBeGreaterThan(blue1);
      expect(red3).toBeGreaterThan(red2);
      expect(red2).toBeGreaterThan(red1);
    }
  });

  it("keeps every class at 3 to 1 or more against the casing it is drawn on", () => {
    for (const theme of themes) {
      const surface = colorValue("surface", theme);
      for (const gain of GAIN_CLASSES) {
        expect(contrast(profileColour(gain, theme), surface)).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(MISSING_COLOUR[theme], surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
