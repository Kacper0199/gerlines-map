import { describe, expect, it } from "vitest";
import { colorValue, trainPalette } from "../theme/tokens.ts";
import {
  hasNeutralMark,
  NEUTRAL_GROUP_SIZE,
  OPERATOR_COLOURS,
  operatorColour,
  operatorColourCss,
} from "./operator-colours.ts";
import { COLOURED_GROUPS, OPERATOR_GROUPS, type OperatorGroup } from "./operator-groups.ts";

type Matrix = readonly (readonly [number, number, number])[];

/**
 * The dataviz validator's measures: Euclidean distance in OKLab times 100, with the colour-blind
 * views from the Machado, Oliveira and Fernandes (2009) matrices at severity 1.0 and the WCAG 2
 * contrast ratio against the map land.
 */
const MATRICES: Readonly<Record<string, Matrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

const TRITANOPIA: Matrix = [
  [1.255528, -0.076749, -0.178779],
  [-0.078411, 0.930809, 0.147602],
  [0.004733, 0.691367, 0.3039],
];

const HUES: readonly OperatorGroup[] = COLOURED_GROUPS.filter((group) => group.id !== "db").map(
  (group) => group.id,
);
const NEUTRALS: readonly OperatorGroup[] = ["db", "other", "unknown"];

const MIN_CVD_DISTANCE_OF_HUES = 8;
const MIN_NORMAL_DISTANCE_OF_HUES = 15;
const MIN_TRITAN_DISTANCE_OF_HUES = 8;
const MIN_TRITAN_DISTANCE_OF_ANY_PAIR = 4.5;
const MIN_CVD_DISTANCE_OF_ANY_PAIR = 9.5;
const MIN_NORMAL_DISTANCE_OF_ANY_PAIR = 10.5;
const MIN_CONTRAST = 3;
const MIN_OKLCH_CHROMA = 0.1;

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: string): number[] {
  return [1, 3, 5].map((index) => linear(Number.parseInt(hex.slice(index, index + 2), 16)));
}

function oklab([r = 0, g = 0, b = 0]: readonly number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function view(hex: string, matrix: Matrix | undefined): number[] {
  const rgb = rgbOf(hex);
  if (!matrix) return rgb;
  return matrix.map((row) =>
    Math.max(
      0,
      Math.min(1, row[0] * (rgb[0] ?? 0) + row[1] * (rgb[1] ?? 0) + row[2] * (rgb[2] ?? 0)),
    ),
  );
}

function distance(first: string, second: string, matrix?: Matrix): number {
  const [l1, a1, b1] = oklab(view(first, matrix));
  const [l2, a2, b2] = oklab(view(second, matrix));
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function cvdDistance(first: string, second: string): number {
  return Math.min(...Object.values(MATRICES).map((matrix) => distance(first, second, matrix)));
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = rgbOf(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first: string, second: string): number {
  const [high = 0, low = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

function chroma(hex: string): number {
  const [, a, b] = oklab(rgbOf(hex));
  return Math.hypot(a, b);
}

function pairsOf<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((first, index) =>
    items.slice(index + 1).map((second): [T, T] => [first, second]),
  );
}

describe.each(["dark", "light"] as const)("operator colours in %s", (theme) => {
  const land = colorValue("map-land", theme);
  const colour = (group: OperatorGroup) => operatorColour(group, theme);

  it("has a colour for every group and none twice", () => {
    for (const group of OPERATOR_GROUPS) expect(colour(group), group).toMatch(/^#[0-9A-F]{6}$/);
    expect(new Set(OPERATOR_GROUPS.map(colour)).size).toBe(OPERATOR_GROUPS.length);
  });

  it("gives every hue chroma enough to read as a colour", () => {
    for (const group of HUES) {
      expect(chroma(colour(group)), group).toBeGreaterThanOrEqual(MIN_OKLCH_CHROMA);
    }
  });

  it("keeps every group 3 to 1 against the land", () => {
    for (const group of OPERATOR_GROUPS) {
      expect(contrast(colour(group), land), group).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("keeps any two hues apart for colour-blind eyes, since a map puts any two trains side by side", () => {
    for (const [first, second] of pairsOf(HUES)) {
      expect(
        cvdDistance(colour(first), colour(second)),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_CVD_DISTANCE_OF_HUES);
    }
  });

  it("keeps any two hues apart under tritanopia, which the validator does not cover", () => {
    for (const [first, second] of pairsOf(HUES)) {
      expect(
        distance(colour(first), colour(second), TRITANOPIA),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_TRITAN_DISTANCE_OF_HUES);
    }
  });

  it("keeps any two of all groups apart under tritanopia by a lower floor, since the smaller neutral marks carry a second channel", () => {
    for (const [first, second] of pairsOf(OPERATOR_GROUPS)) {
      expect(
        distance(colour(first), colour(second), TRITANOPIA),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_TRITAN_DISTANCE_OF_ANY_PAIR);
    }
  });

  it("keeps any two hues apart for normal eyes by the validator's floor", () => {
    for (const [first, second] of pairsOf(HUES)) {
      expect(
        distance(colour(first), colour(second)),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_NORMAL_DISTANCE_OF_HUES);
    }
  });

  it("keeps any two of all groups, Deutsche Bahn, Other and Unknown included, apart for colour-blind eyes", () => {
    for (const [first, second] of pairsOf(OPERATOR_GROUPS)) {
      expect(
        cvdDistance(colour(first), colour(second)),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_CVD_DISTANCE_OF_ANY_PAIR);
    }
  });

  it("keeps any two of all groups apart for normal eyes", () => {
    for (const [first, second] of pairsOf(OPERATOR_GROUPS)) {
      expect(
        distance(colour(first), colour(second)),
        `${first} against ${second}`,
      ).toBeGreaterThanOrEqual(MIN_NORMAL_DISTANCE_OF_ANY_PAIR);
    }
  });

  it("keeps the neutral groups apart from every colour under the colour-blind views one by one", () => {
    for (const neutral of NEUTRALS) {
      for (const other of OPERATOR_GROUPS.filter((group) => group !== neutral)) {
        for (const [kind, matrix] of Object.entries(MATRICES)) {
          expect(
            distance(colour(neutral), colour(other), matrix),
            `${neutral} against ${other} under ${kind}`,
          ).toBeGreaterThanOrEqual(MIN_CVD_DISTANCE_OF_ANY_PAIR);
        }
      }
    }
  });

  it("builds the palette the trains are drawn with from the same colours", () => {
    const operator = trainPalette(theme).operator;
    for (const group of OPERATOR_GROUPS) {
      const hex = colour(group);
      expect(operator?.[group], group).toEqual(
        [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)),
      );
    }
  });
});

describe("second channel of the neutral groups", () => {
  it("marks only Other and Unknown with a smaller dot", () => {
    expect(OPERATOR_GROUPS.filter(hasNeutralMark)).toEqual(["other", "unknown"]);
    expect(NEUTRAL_GROUP_SIZE).toBeLessThan(1);
  });
});

describe("operator colour swatch", () => {
  it("follows the colour scheme of the page", () => {
    expect(operatorColourCss("transdev")).toBe(
      `light-dark(${OPERATOR_COLOURS.transdev.light}, ${OPERATOR_COLOURS.transdev.dark})`,
    );
  });
});
