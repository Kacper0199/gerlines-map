export const CATEGORIES = ["hsr", "ld", "rfast", "reg", "sbahn", "foreign"] as const;
export type Category = (typeof CATEGORIES)[number];

const DARK_HEX: Record<Category, string> = {
  hsr: "#EDE6D6",
  ld: "#B9AF98",
  rfast: "#9CC5F6",
  reg: "#5F97DE",
  sbahn: "#5FC08A",
  foreign: "#8F87A8",
};

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export const CATEGORY_RGBA: Record<Category, [number, number, number, number]> = Object.fromEntries(
  CATEGORIES.map((category) => {
    const [r, g, b] = hexToRgb(DARK_HEX[category]);
    return [category, [r, g, b, 255]];
  }),
) as Record<Category, [number, number, number, number]>;

export function categoryIndex(category: string): number {
  const index = CATEGORIES.indexOf(category as Category);
  return index === -1 ? CATEGORIES.indexOf("reg") : index;
}
