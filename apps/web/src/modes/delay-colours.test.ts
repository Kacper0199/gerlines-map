import { describe, expect, it } from "vitest";
import { trainPalette } from "../theme/tokens.ts";
import { DELAY_CLASSES, type DelayClass } from "./delay.ts";

type Matrix = readonly (readonly [number, number, number])[];

/**
 * Machado, Oliveira and Fernandes (2009) simulation matrices at severity 1.0, applied to linear
 * sRGB. The distance is CIEDE2000 (Sharma, Wu and Dalal 2005) in Lab (D65), where 2.3 is one just
 * noticeable difference. The floors below are our own, set under the measured minimum of the
 * palette: the weakest pairs (ok against major under protanopia, severe against none) rest on the
 * legend and the labels as a second channel. The palette is checked, not validated for clinical use.
 */
const SIMULATIONS: Readonly<Record<string, Matrix>> = {
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
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const MIN_DELTA_E = 6;
const MIN_DELTA_E_DOMESTIC_PAIRS = 15;
const MIN_DARK_CONTRAST_OF_SEVERE = 6;
const SHARED_BY_DESIGN = new Set(["foreign none"]);
const DOMESTIC: readonly DelayClass[] = ["ok", "minor", "major", "severe"];

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function gamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return 255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055);
}

function simulate(rgb: readonly number[], matrix: Matrix | undefined): number[] {
  if (!matrix) return [...rgb];
  const lin = rgb.map(linear);
  return matrix.map((row) =>
    gamma(row[0] * (lin[0] ?? 0) + row[1] * (lin[1] ?? 0) + row[2] * (lin[2] ?? 0)),
  );
}

function lab(rgb: readonly number[]): [number, number, number] {
  const [r = 0, g = 0, b = 0] = rgb.map(linear);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

function hueOf(a: number, b: number): number {
  return (Math.atan2(b, a) * 180) / Math.PI + (b < 0 || (b === 0 && a < 0) ? 360 : 0);
}

function deltaE(first: readonly number[], second: readonly number[]): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1 = Math.hypot(a1p, b1);
  const c2 = Math.hypot(a2p, b2);
  const h1 = hueOf(a1p, b1);
  const h2 = hueOf(a2p, b2);
  const gray = c1 * c2 === 0;
  let dh = gray ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const dL = l2 - l1;
  const dC = c2 - c1;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
  const meanL = (l1 + l2) / 2;
  const meanC = (c1 + c2) / 2;
  let meanH = h1 + h2;
  if (!gray) {
    meanH = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(meanH - 30)) +
    0.24 * Math.cos(rad(2 * meanH)) +
    0.32 * Math.cos(rad(3 * meanH + 6)) -
    0.2 * Math.cos(rad(4 * meanH - 63));
  const rc = 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
  const rt = -Math.sin(rad(60 * Math.exp(-(((meanH - 275) / 25) ** 2)))) * rc;
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

function contrast(first: readonly number[], second: readonly number[]): number {
  const y = (rgb: readonly number[]) => {
    const [r = 0, g = 0, b = 0] = rgb.map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [Math.max(y(first), y(second)), Math.min(y(first), y(second))];
  return (high + 0.05) / (low + 0.05);
}

function floorOf(first: DelayClass, second: DelayClass, simulated: boolean): number {
  const domesticPair = DOMESTIC.includes(first) && DOMESTIC.includes(second);
  return domesticPair && !simulated ? MIN_DELTA_E_DOMESTIC_PAIRS : MIN_DELTA_E;
}

function pairs(): [DelayClass, DelayClass][] {
  const result: [DelayClass, DelayClass][] = [];
  for (const first of DELAY_CLASSES) {
    for (const second of DELAY_CLASSES) {
      if (first < second && !SHARED_BY_DESIGN.has(`${first} ${second}`))
        result.push([first, second]);
    }
  }
  return result;
}

describe.each(["dark", "light"] as const)("delay colours in %s", (theme) => {
  const delay = trainPalette(theme).delay;

  it("defines every class", () => {
    for (const name of DELAY_CLASSES) expect(delay?.[name]).toHaveLength(3);
  });

  it.each([undefined, ...Object.keys(SIMULATIONS)])(
    "keeps every pair of classes apart under %s",
    (kind) => {
      const matrix = kind === undefined ? undefined : SIMULATIONS[kind];
      for (const [first, second] of pairs()) {
        const distance = deltaE(
          simulate(delay?.[first] ?? [], matrix),
          simulate(delay?.[second] ?? [], matrix),
        );
        expect(distance, `${first} against ${second}`).toBeGreaterThanOrEqual(
          floorOf(first, second, matrix !== undefined),
        );
      }
    },
  );
});

describe("delay colours against the land", () => {
  const rgb = (hex: string) =>
    [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

  it("reads the severe class strongest on the dark map: more contrast than the missing data class", () => {
    const delay = trainPalette("dark").delay;
    const land = rgb("#1A1B1D");
    const severe = contrast(delay?.severe ?? [], land);
    expect(severe).toBeGreaterThanOrEqual(MIN_DARK_CONTRAST_OF_SEVERE);
    expect(severe).toBeGreaterThan(contrast(delay?.none ?? [], land));
  });

  it("reads the severe class strongest on the light map: more contrast than the major class", () => {
    const delay = trainPalette("light").delay;
    const land = rgb("#EDEBE5");
    expect(contrast(delay?.severe ?? [], land)).toBeGreaterThan(contrast(delay?.major ?? [], land));
  });
});
