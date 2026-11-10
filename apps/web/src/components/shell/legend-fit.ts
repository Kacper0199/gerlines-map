export const LEGEND_FIT_STEPS = ["full", "styleFolded", "folded", "collapsed"] as const;

export type LegendFit = (typeof LEGEND_FIT_STEPS)[number];

export const LEGEND_PIN_STEP: LegendFit = "folded";

export function foldsStyleCard(fit: LegendFit): boolean {
  return fit !== "full";
}

export function foldsLabelControl(fit: LegendFit): boolean {
  return fit === "folded" || fit === "collapsed";
}
