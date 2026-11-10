export type ThemeName = "dark" | "light";

export const THEME_NAMES: readonly ThemeName[] = ["dark", "light"];
export const DEFAULT_THEME: ThemeName = "dark";

export interface ColorToken {
  readonly light: string;
  readonly dark?: string;
}

export const COLOR_TOKENS = {
  primary: { light: "#F08C00", dark: "#FFB000" },
  "on-primary": { light: "#1B1A18", dark: "#17181A" },
  "primary-text": { light: "#A85F00", dark: "#FFB000" },
  secondary: { light: "#5F97DE" },
  neutral: { light: "#F1EFEA", dark: "#1F2023" },
  surface: { light: "#FBFAF7", dark: "#17181A" },
  ink: { light: "#1B1A18", dark: "#F1EFEA" },
  "ink-muted": { light: "#5F5B54", dark: "#A09D96" },
  hairline: { light: "#DAD6CC", dark: "#2C2E32" },
  passed: { light: "#8C877D", dark: "#66676B" },
  focus: { light: "#1B1A18", dark: "#F1EFEA" },
  error: { light: "#C2503F", dark: "#E58F8F" },
  "map-land": { light: "#EDEBE5", dark: "#1A1B1D" },
  "map-water": { light: "#C7CFD3", dark: "#121315" },
  "map-sea": { light: "#A2AFB7", dark: "#080C11" },
  "map-rail": { light: "#B2AEA5", dark: "#3A3B3F" },
  "map-label": { light: "#625E57", dark: "#8D8A84" },
  "map-label-city": { light: "#47433D", dark: "#A7A39B" },
  "map-label-water": { light: "#46555D", dark: "#868480" },
  "map-land-tint": { light: "#E6E3DC", dark: "#1E1F21" },
  "map-green": { light: "#E1E4DA", dark: "#1D1F1E" },
  "map-building": { light: "#E3E0D8", dark: "#1E1F21" },
  "map-building-outline": { light: "#E6E3DC", dark: "#1E1F21" },
  "map-road-minor": { light: "#E0DDD5", dark: "#262729" },
  "map-road-major-casing": { light: "#E6E3DC", dark: "#212224" },
  "map-road-major": { light: "#D6D2C8", dark: "#2C2D2F" },
  "map-road-motorway-casing": { light: "#E6E3DC", dark: "#212224" },
  "map-road-motorway": { light: "#C9C4B8", dark: "#323336" },
  "map-mask": { light: "#6E6C66", dark: "#0C0C0D" },
  "map-outline": { light: "#7A766E", dark: "#5A5B60" },
  "map-boundary-state": { light: "#CFCBC1", dark: "#2F3033" },
  "map-boundary-country": { light: "#7C7870", dark: "#55565B" },
  "map-rail-satellite": { light: "#A7A39B" },
  "map-boundary-satellite": { light: "#8D8A84" },
  "cat-hsr": { light: "#26231E", dark: "#EDE6D6" },
  "cat-ld": { light: "#6A604C", dark: "#B9AF98" },
  "cat-rfast": { light: "#3F83D6", dark: "#9CC5F6" },
  "cat-reg": { light: "#1F5EB0", dark: "#5F97DE" },
  "cat-sbahn": { light: "#17814C", dark: "#5FC08A" },
  "cat-foreign": { light: "#6F6790", dark: "#8F87A8" },
  "delay-ok": { light: "#1F8E78", dark: "#7CC9B4" },
  "delay-minor": { light: "#9E7A00", dark: "#E8D7A0" },
  "delay-major": { light: "#C2503F", dark: "#E58F8F" },
  "delay-severe": { light: "#7A2A5C", dark: "#E86BD0" },
} as const satisfies Record<string, ColorToken>;

export type ColorName = keyof typeof COLOR_TOKENS;

export interface TypographyToken {
  readonly family: "Overpass" | "Overpass Mono";
  readonly size: number;
  readonly weight: number;
  readonly lineHeight: number;
  readonly letterSpacing?: string;
}

export const TYPOGRAPHY_TOKENS = {
  display: {
    family: "Overpass Mono",
    size: 38,
    weight: 600,
    lineHeight: 1,
    letterSpacing: "-0.03em",
  },
  headline: {
    family: "Overpass",
    size: 32,
    weight: 800,
    lineHeight: 1.05,
    letterSpacing: "-0.02em",
  },
  wordmark: { family: "Overpass", size: 22, weight: 800, lineHeight: 1, letterSpacing: "-0.02em" },
  title: { family: "Overpass", size: 18, weight: 800, lineHeight: 1.25, letterSpacing: "-0.01em" },
  "body-strong": { family: "Overpass", size: 16, weight: 600, lineHeight: 1.4 },
  body: { family: "Overpass", size: 14, weight: 400, lineHeight: 1.45 },
  label: { family: "Overpass", size: 13, weight: 600, lineHeight: 1.3 },
  caption: { family: "Overpass", size: 12, weight: 400, lineHeight: 1.45 },
  data: {
    family: "Overpass Mono",
    size: 15,
    weight: 600,
    lineHeight: 1.15,
    letterSpacing: "-0.03em",
  },
  "data-small": {
    family: "Overpass Mono",
    size: 12,
    weight: 400,
    lineHeight: 1.3,
    letterSpacing: "-0.03em",
  },
} as const satisfies Record<string, TypographyToken>;

export type TypographyName = keyof typeof TYPOGRAPHY_TOKENS;

export const ROUNDED_TOKENS = {
  thumb: 6,
  control: 8,
  card: 10,
  "card-phone": 12,
  pill: 999,
} as const;

export const SPACING_TOKENS = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 24,
  target: 40,
  "target-phone": 44,
} as const;

export const SHADOW_TOKENS: Readonly<Record<ThemeName, string>> = {
  dark: "0 8px 24px rgba(0, 0, 0, 0.35)",
  light: "0 8px 24px rgba(40, 34, 20, 0.16)",
};

export const MOTION_TOKENS = {
  panelMs: 200,
  routeDrawMs: 600,
  progressGlideMs: 600,
  easeOut: "cubic-bezier(0.2, 0.7, 0.2, 1)",
} as const;

export const PHONE_MAX_WIDTH = 640;
export const SHEET_PEEK_HEIGHT = 304;
export const SHEET_EXPANDED_INSET = 120;

export const CATEGORY_KEYS = ["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const CATEGORY_COLOR_NAMES = {
  hsr: "cat-hsr",
  ld: "cat-ld",
  night: "cat-hsr",
  rfast: "cat-rfast",
  reg: "cat-reg",
  sbahn: "cat-sbahn",
  foreign: "cat-foreign",
} as const satisfies Record<CategoryKey, ColorName>;

export const FOREIGN_OPACITY = 0.7;

export const DELAY_KEYS = ["ok", "minor", "major", "severe"] as const;
export type DelayKey = (typeof DELAY_KEYS)[number];

export function colorValue(name: ColorName, theme: ThemeName): string {
  const token: ColorToken = COLOR_TOKENS[name];
  return theme === "dark" ? (token.dark ?? token.light) : token.light;
}

export function categoryColor(theme: ThemeName, category: CategoryKey): string {
  return colorValue(CATEGORY_COLOR_NAMES[category], theme);
}
