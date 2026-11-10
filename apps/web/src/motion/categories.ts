export type CategoryKey = "hsr" | "ld" | "night" | "rfast" | "reg" | "sbahn" | "foreign";

export const DRAW_ORDER: Readonly<Record<CategoryKey, number>> = {
  foreign: 0,
  reg: 1,
  rfast: 2,
  sbahn: 3,
  ld: 4,
  night: 4,
  hsr: 5,
};
