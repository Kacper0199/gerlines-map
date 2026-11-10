import type { LiveryInput, LiveryRole } from "./catalog.ts";
import { encodePng } from "./png.ts";

/** Atlas columns: every face of a model samples the centre of one slot cell. */
export const SLOTS = [
  "body",
  "upper_body",
  "lower_body",
  "window_band",
  "stripe",
  "doors",
  "accent",
  "window",
  "roof",
  "underframe",
  "bogie",
  "gangway",
  "light",
  "reveal",
  "mode",
  "skirt",
  "mask",
  "equipment",
  "housing",
  "glass",
  "sheen",
  "display",
  "tail",
  "logo",
  "logo_ink",
] as const;
export type Slot = (typeof SLOTS)[number];

export const ATLAS_COLUMNS = 32;

export function slotU(slot: Slot): number {
  return (SLOTS.indexOf(slot) + 0.5) / ATLAS_COLUMNS;
}

/**
 * A lens of a combined lamp: inside the light cell (same colour, nearest sampling) but off its
 * centre, at a quarter of the cell, so a renderer can show it white at the leading end and red at
 * the trailing end. A renderer that reads only the cell treats it as any white lens.
 */
export const COMBINED_TAIL_U = (SLOTS.indexOf("light") + 0.25) / ATLAS_COLUMNS;

/** A model's own single-row palette is sampled at v = 0.5; the shared atlas maps row r to (r + 0.5) / rows. */
export const ROW_V = 0.5;

/**
 * Neutral vehicle colours (DESIGN.md tokens): every slot no livery source names, and the
 * whole row of a model without a sourced livery. No slot carries a category colour: the colour mode
 * lives on the roof band (D-039). The DB plate's field has its own `logo` slot in the Verkehrsrot of
 * the tail lens, so a renderer that lights the tail column at the trailing end leaves the logo alone.
 */
const NEUTRAL: Readonly<Record<Exclude<Slot, "mode">, string>> = {
  body: "#dad6cc",
  upper_body: "#dad6cc",
  lower_body: "#dad6cc",
  window_band: "#1b1a18",
  stripe: "#dad6cc",
  doors: "#b2aea5",
  accent: "#dad6cc",
  window: "#2b323b",
  roof: "#8c877d",
  underframe: "#3a3b3f",
  bogie: "#56595e",
  gangway: "#1f2023",
  light: "#f1efea",
  reveal: "#5f5b54",
  skirt: "#dad6cc",
  mask: "#3a3b3f",
  equipment: "#858b91",
  housing: "#111214",
  glass: "#3a4550",
  sheen: "#56636f",
  display: "#e39a2d",
  tail: "#c1121c",
  logo: "#c1121c",
  logo_ink: "#dad6cc",
};

/** Category colours of DESIGN.md (light theme): the default of the roof band per model. */
export const CATEGORY_COLOURS: Readonly<Record<string, string>> = {
  hsr: "#26231e",
  ld: "#6a604c",
  night: "#26231e",
  rfast: "#3f83d6",
  reg: "#1f5eb0",
  sbahn: "#17814c",
  foreign: "#6f6790",
};

/** The mode cell of the shared atlas: a placeholder WP-5.2 replaces per instance. */
export const MODE_PLACEHOLDER = "#8c877d";

export type SlotOrigin = "livery" | "neutral" | "mode";

export interface PaletteRow {
  readonly id: string;
  readonly colours: Readonly<Record<Slot, string>>;
  readonly origin: Readonly<Record<Slot, SlotOrigin>>;
  /** Slots written with alpha 0: the renderer draws nothing there (the DB logo of a row that is not DB's). */
  readonly hidden: readonly Slot[];
}

const LOGO_SLOTS: readonly Slot[] = ["logo", "logo_ink"];

export function neutralRow(): PaletteRow {
  const colours = { ...NEUTRAL, mode: MODE_PLACEHOLDER } as Record<Slot, string>;
  const origin = Object.fromEntries(
    SLOTS.map((s) => [s, s === "mode" ? "mode" : "neutral"]),
  ) as Record<Slot, SlotOrigin>;
  return { id: "neutral", colours, origin, hidden: LOGO_SLOTS };
}

const FALLBACK: Partial<Record<Slot, readonly LiveryRole[]>> = {
  body: ["body"],
  upper_body: ["upper_body", "body"],
  lower_body: ["lower_body", "body"],
  window_band: ["window_band", "upper_body", "body"],
  stripe: ["stripe", "lower_body", "body"],
  doors: ["doors", "body", "lower_body"],
  accent: ["accent", "stripe", "body"],
  roof: ["roof", "upper_body", "body"],
  skirt: ["skirt", "accent", "lower_body", "body"],
  equipment: ["mask"],
  logo_ink: ["doors", "body", "lower_body"],
};

/**
 * A livery's mask role is the painted helmet or mask (the equipment slot that fronts name with
 * mask_slot: equipment, and the roof boxes); the mask slot stays the neutral dark surround of the
 * glass, lamps and side window pillars.
 *
 * Resolves a livery into a palette row, independent of any category. The DB logo is visible only
 * when `showsLogo` (the livery names an operator of the DB group). A slot takes the first role
 * of its fallback chain the livery names: its cited hex, or the neutral colour when the role is
 * named without a hex (the colour stays missing). Slots no named role reaches stay neutral.
 */
export function liveryRow(livery: LiveryInput, showsLogo = false): PaletteRow {
  const named = new Map<LiveryRole, string | null>();
  for (const colour of livery.colours) {
    if (!named.get(colour.role))
      named.set(colour.role, colour.hex ? colour.hex.toLowerCase() : null);
  }
  const neutral = neutralRow();
  const colours = { ...neutral.colours };
  const origin = { ...neutral.origin };
  for (const slot of SLOTS) {
    const role = (FALLBACK[slot] ?? []).find((r) => named.has(r));
    const hex = role ? named.get(role) : null;
    if (hex) {
      colours[slot] = hex;
      origin[slot] = "livery";
    }
  }
  return { id: livery.livery_id, colours, origin, hidden: showsLogo ? [] : LOGO_SLOTS };
}

/** The row embedded in one model's files: its livery (or neutral) with its category on the band. */
export function modelRow(row: PaletteRow, category: string): PaletteRow {
  const mode = CATEGORY_COLOURS[category] ?? MODE_PLACEHOLDER;
  return { ...row, colours: { ...row.colours, mode } };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * The indices of the rows that show the DB logo (neither logo cell transparent). The web culls the
 * logo triangles of every other row in its vertex shader, so the list travels in the
 * manifest next to the atlas.
 */
export function logoRows(rows: readonly PaletteRow[]): number[] {
  return rows.flatMap((row, index) =>
    LOGO_SLOTS.some((s) => row.hidden.includes(s)) ? [] : [index],
  );
}

/** Paints palette rows into an atlas PNG: one pixel row per palette row, one pixel per slot. */
export function atlasPng(rows: readonly PaletteRow[]): Uint8Array {
  const width = ATLAS_COLUMNS;
  const rgba = new Uint8Array(width * rows.length * 4);
  rows.forEach((row, r) => {
    for (let column = 0; column < ATLAS_COLUMNS; column++) {
      const slot = SLOTS[column];
      const [red, green, blue] = slot ? hexToRgb(row.colours[slot]) : [0, 0, 0];
      const alpha = slot && row.hidden.includes(slot) ? 0 : 255;
      rgba.set([red, green, blue, alpha], (r * width + column) * 4);
    }
  });
  return encodePng(width, rows.length, rgba);
}
