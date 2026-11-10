import type { ThemeName } from "@gerlines/ui/tokens";
import type { OperatorGroup } from "./operator-groups.ts";

/**
 * The colour of each operator group on the dark and the light map. The five hues pass the dataviz
 * validator in its any-pair mode, the one for map dots (any two trains can sit side by side), in both
 * themes: colour-blind distance 11.9 and 12.0, normal-vision distance 17.0 and 19.2, 3:1 against the
 * land, no amber, which is the selection. Under tritanopia, which the validator does not cover, the
 * five hues stay at least 10.4 apart on dark and 8.6 on light. Deutsche Bahn, most of the trains, is
 * the quiet ivory and charcoal of the high speed mark. Other and Unknown are neutrals that stay at
 * least 10.0 from every other colour for protan and deutan eyes and 11.1 for normal vision; they also
 * draw as smaller dots, so colour is not their only channel (SWEG against Other is 4.6 under
 * tritanopia on light). The colours encode groups and are not brand colours.
 */
export const OPERATOR_COLOURS: Readonly<
  Record<OperatorGroup, { readonly dark: string; readonly light: string }>
> = {
  db: { dark: "#EDE6D6", light: "#26231E" },
  transdev: { dark: "#9B5724", light: "#B87240" },
  netinera: { dark: "#2697F0", light: "#0E8AE2" },
  kvvh: { dark: "#6254CC", light: "#482AB4" },
  hlb: { dark: "#DB5DAB", light: "#DE459F" },
  sweg: { dark: "#849E4E", light: "#465C00" },
  other: { dark: "#B5B7BA", light: "#46484A" },
  unknown: { dark: "#736371", light: "#79635F" },
};

/** Other and Unknown draw this much smaller than the named groups, as a second channel beside their colour. */
export const NEUTRAL_GROUP_SIZE = 0.8;

export function hasNeutralMark(group: OperatorGroup): boolean {
  return group === "other" || group === "unknown";
}

export function operatorColour(group: OperatorGroup, theme: ThemeName): string {
  return OPERATOR_COLOURS[group][theme];
}

/** The colour as a CSS value that follows the page's colour scheme, for a legend swatch. */
export function operatorColourCss(group: OperatorGroup): string {
  const { light, dark } = OPERATOR_COLOURS[group];
  return `light-dark(${light}, ${dark})`;
}
