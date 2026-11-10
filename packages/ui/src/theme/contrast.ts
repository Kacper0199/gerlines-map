import { type ColorName, colorValue, type ThemeName } from "./tokens.ts";

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new TypeError(`Expected a six digit hex colour, got ${hex}`);
  }
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) =>
    channel(Number.parseInt(part as string, 16)),
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function tokenContrast(
  foreground: ColorName,
  background: ColorName,
  theme: ThemeName,
): number {
  return contrastRatio(colorValue(foreground, theme), colorValue(background, theme));
}

function toLinear(value: number): number {
  return channel(value);
}

function fromLinear(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function rgbOf(hex: string): [number, number, number] {
  relativeLuminance(hex);
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function hexOf(rgb: readonly number[]): string {
  return `#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: readonly [number, number, number]): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return hexOf([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** CSS `color-mix(in oklab, first share%, second)` for two opaque colours. */
export function mixOklab(first: string, second: string, firstShare: number): string {
  const [a, b] = [toOklab(first), toOklab(second)];
  const mixed = a.map((part, index) => part * firstShare + (b[index] as number) * (1 - firstShare));
  return fromOklab(mixed as [number, number, number]);
}

/** A colour at `alpha` laid over an opaque background, blended in sRGB like a browser does. */
export function overlay(foreground: string, background: string, alpha: number): string {
  const [front, back] = [rgbOf(foreground), rgbOf(background)];
  return hexOf(
    front.map((part, index) => Math.round(part * alpha + (back[index] as number) * (1 - alpha))),
  );
}
