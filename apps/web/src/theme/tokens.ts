import { type CategoryKey, categoryColor, colorValue, type ThemeName } from "@gerlines/ui/tokens";
import { operatorColour } from "../modes/operator-colours.ts";
import { OPERATOR_GROUPS, type OperatorGroup } from "../modes/operator-groups.ts";
import type { Palette, Rgb } from "../motion/frame.ts";

export { categoryColor, colorValue, type ThemeName };

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const CATEGORIES: readonly CategoryKey[] = [
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "foreign",
];

export function hexToRgb(hex: string): Rgb {
  const match = HEX_COLOR.exec(hex);
  if (!match) {
    throw new TypeError(`Expected a six digit hex colour, got ${hex}`);
  }
  return [
    Number.parseInt(match[1] as string, 16),
    Number.parseInt(match[2] as string, 16),
    Number.parseInt(match[3] as string, 16),
  ];
}

export function trainPalette(theme: ThemeName): Palette {
  const fill = Object.fromEntries(
    CATEGORIES.map((category) => [category, hexToRgb(categoryColor(theme, category))]),
  ) as Record<CategoryKey, Rgb>;
  const delay = {
    ok: hexToRgb(colorValue("delay-ok", theme)),
    minor: hexToRgb(colorValue("delay-minor", theme)),
    major: hexToRgb(colorValue("delay-major", theme)),
    severe: hexToRgb(colorValue("delay-severe", theme)),
    none: fill.foreign,
    foreign: fill.foreign,
  };
  const operator = Object.fromEntries(
    OPERATOR_GROUPS.map((group) => [group, hexToRgb(operatorColour(group, theme))]),
  ) as Record<OperatorGroup, Rgb>;
  return { fill, land: hexToRgb(colorValue("map-land", theme)), delay, operator };
}
