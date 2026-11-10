import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, mixOklab, overlay } from "./contrast.ts";
import { type ColorName, colorValue, SPACING_TOKENS, type ThemeName } from "./tokens.ts";

const THEMES: readonly ThemeName[] = ["dark", "light"];
const TEXT = 4.5;
const PART = 3;

const buttonSource = readFileSync(new URL("../components/ui/button.tsx", import.meta.url), "utf8");

function buttonAlpha(state: "hover" | "active"): number {
  const match = new RegExp(`${state}:bg-ink/(\\d+)`).exec(buttonSource);
  if (match === null) throw new Error(`the solid button has no ${state} ink alpha`);
  return Number(match[1]) / 100;
}

const generated = readFileSync(new URL("../styles/theme.generated.css", import.meta.url), "utf8");

function mixFormula(
  declaration: string,
  theme: ThemeName,
): { first: string; share: number; second: string } {
  const block =
    theme === "dark"
      ? generated.slice(0, generated.indexOf(':root[data-theme="light"]'))
      : generated.slice(generated.indexOf(':root[data-theme="light"]'));
  const pattern = new RegExp(
    `${declaration}: color-mix\\(in oklab, var\\(--gl-([a-z-]+)\\) (\\d+)%, var\\(--gl-([a-z-]+)\\)\\)`,
  );
  const match = pattern.exec(block);
  if (match === null) throw new Error(`${declaration} is not a colour mix in the ${theme} theme`);
  return {
    first: colorValue(match[1] as ColorName, theme),
    share: Number(match[2]) / 100,
    second: colorValue(match[3] as ColorName, theme),
  };
}

function derived(theme: ThemeName) {
  const hover = generated.match(
    /--color-raised-hover: color-mix\(in oklab, var\(--gl-neutral\) (\d+)%, var\(--gl-ink\)\)/,
  );
  if (hover === null) throw new Error("raised-hover is not a colour mix");
  const surface = colorValue("surface", theme);
  const ink = colorValue("ink", theme);
  const selectionHover = mixFormula("--gl-selection-hover", theme);
  const selectionActive = mixFormula("--gl-selection-active", theme);
  return {
    raisedHover: mixOklab(colorValue("neutral", theme), ink, Number(hover[1]) / 100),
    selectionHover: mixOklab(selectionHover.first, selectionHover.second, selectionHover.share),
    selectionActive: mixOklab(selectionActive.first, selectionActive.second, selectionActive.share),
    solidHover: overlay(ink, surface, buttonAlpha("hover")),
    solidActive: overlay(ink, surface, buttonAlpha("active")),
  };
}

type Pair = readonly [
  name: string,
  foreground: (theme: ThemeName) => string,
  background: (theme: ThemeName) => string,
];

const token = (name: ColorName) => (theme: ThemeName) => colorValue(name, theme);
const state = (pick: keyof ReturnType<typeof derived>) => (theme: ThemeName) =>
  derived(theme)[pick];

const TEXT_PAIRS: readonly Pair[] = [
  ["ink on surface (body, cards, live bar)", token("ink"), token("surface")],
  ["ink on raised (secondary buttons, fields, pressed tabs)", token("ink"), token("neutral")],
  ["ink on raised hover", token("ink"), state("raisedHover")],
  ["muted ink on surface (secondary text, scheduled times)", token("ink-muted"), token("surface")],
  ["muted ink on raised (placeholders, captions in fields)", token("ink-muted"), token("neutral")],
  ["text on selection fill (Follow button)", token("on-primary"), token("primary")],
  ["text on selection hover", token("on-primary"), state("selectionHover")],
  ["text on selection pressed", token("on-primary"), state("selectionActive")],
  ["surface text on the solid ink button", token("surface"), token("ink")],
  ["surface text on the solid ink button, hover", token("surface"), state("solidHover")],
  ["surface text on the solid ink button, pressed", token("surface"), state("solidActive")],
  ["selection text on surface", token("primary-text"), token("surface")],
  ["map labels on land", token("map-label"), token("map-land")],
  ["map city labels on land", token("map-label-city"), token("map-land")],
  ["map labels on tinted land", token("map-label"), token("map-land-tint")],
  ["map labels on green", token("map-label"), token("map-green")],
  ["water labels on water", token("map-label-water"), token("map-water")],
];

const PART_PAIRS: readonly Pair[] = [
  ["focus ring on surface", token("focus"), token("surface")],
  ["focus ring on raised", token("focus"), token("neutral")],
  ["focus ring on land", token("focus"), token("map-land")],
  ["switch and checkbox border on surface", token("passed"), token("surface")],
  ["error icon on surface", token("error"), token("surface")],
  ["error icon on raised", token("error"), token("neutral")],
  ["switch thumb on its raised track", token("ink-muted"), token("neutral")],
  ["progress dot and route on surface", token("primary-text"), token("surface")],
  ["hsr mark on land", token("cat-hsr"), token("map-land")],
  ["long distance mark on land", token("cat-ld"), token("map-land")],
  ["regional express mark on land", token("cat-rfast"), token("map-land")],
  ["regional mark on land", token("cat-reg"), token("map-land")],
  ["S-Bahn mark on land", token("cat-sbahn"), token("map-land")],
  ["hsr mark on surface (legend)", token("cat-hsr"), token("surface")],
  ["long distance mark on surface", token("cat-ld"), token("surface")],
  ["regional express mark on surface", token("cat-rfast"), token("surface")],
  ["regional mark on surface", token("cat-reg"), token("surface")],
  ["S-Bahn mark on surface", token("cat-sbahn"), token("surface")],
  [
    "foreign mark on surface (legend, before its 70 percent)",
    token("cat-foreign"),
    token("surface"),
  ],
  ["foreign mark on land (before its 70 percent)", token("cat-foreign"), token("map-land")],
  ["delay ok swatch on surface", token("delay-ok"), token("surface")],
  ["delay minor swatch on surface", token("delay-minor"), token("surface")],
  ["delay minor on land", token("delay-minor"), token("map-land")],
  ["delay major swatch on surface", token("delay-major"), token("surface")],
  ["delay severe swatch on surface", token("delay-severe"), token("surface")],
  ["delay ok on land", token("delay-ok"), token("map-land")],
  ["delay major on land", token("delay-major"), token("map-land")],
  ["delay severe on land", token("delay-severe"), token("map-land")],
];

describe.each(THEMES)("%s theme: every text pair reaches 4.5", (theme) => {
  it.each(TEXT_PAIRS)("%s", (_name, foreground, background) => {
    expect(contrastRatio(foreground(theme), background(theme))).toBeGreaterThanOrEqual(TEXT);
  });
});

const DARK_ONLY_PART_PAIRS: readonly Pair[] = [
  ["selection fill on land", token("primary"), token("map-land")],
  ["selection fill on surface", token("primary"), token("surface")],
];

describe("dark theme: pairs that only the dark theme meets (the light ones are recorded below)", () => {
  it.each(DARK_ONLY_PART_PAIRS)("%s", (_name, foreground, background) => {
    expect(contrastRatio(foreground("dark"), background("dark"))).toBeGreaterThanOrEqual(PART);
  });
});

describe.each(THEMES)("%s theme: every interface part pair reaches 3", (theme) => {
  it.each(PART_PAIRS)("%s", (_name, foreground, background) => {
    expect(contrastRatio(foreground(theme), background(theme))).toBeGreaterThanOrEqual(PART);
  });
});

interface Gap {
  readonly name: string;
  readonly theme: ThemeName;
  readonly foreground: ColorName;
  readonly background: ColorName;
  readonly needs: number;
  readonly floor: number;
}

/** Pairs below their requirement, kept with their measured floor so a token change shows up here. */
const KNOWN_GAPS: readonly Gap[] = [
  {
    name: "selection fill on land",
    theme: "light",
    foreground: "primary",
    background: "map-land",
    needs: PART,
    floor: 2.0,
  },
  {
    name: "selection fill on surface",
    theme: "light",
    foreground: "primary",
    background: "surface",
    needs: PART,
    floor: 2.3,
  },
];

describe("pairs that fall short and are proposed for change", () => {
  it.each(KNOWN_GAPS)("$name in the $theme theme stays at its recorded floor", (gap) => {
    const ratio = contrastRatio(
      colorValue(gap.foreground, gap.theme),
      colorValue(gap.background, gap.theme),
    );
    expect(ratio).toBeLessThan(gap.needs);
    expect(ratio).toBeGreaterThanOrEqual(gap.floor);
  });
});

describe("derived colours", () => {
  it("mixes in oklab like the browser: white and black half and half is the mid grey", () => {
    expect(mixOklab("#FFFFFF", "#000000", 0.5)).toBe("#636363");
    expect(mixOklab("#336699", "#336699", 0.3)).toBe("#336699");
  });

  it("lays a translucent colour over its background in sRGB", () => {
    expect(overlay("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });
});

describe("target sizes", () => {
  it("keeps the desktop target at 40 px and the phone target at 44 px, over the 24 px minimum of WCAG 2.5.8", () => {
    expect(SPACING_TOKENS.target).toBe(40);
    expect(SPACING_TOKENS["target-phone"]).toBe(44);
    expect(SPACING_TOKENS.target).toBeGreaterThanOrEqual(24);
  });
});
