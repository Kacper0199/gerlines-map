import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

export type CarRole =
  | "cab"
  | "middle"
  | "power_head"
  | "locomotive"
  | "coach"
  | "driving_trailer"
  | "railcar";
export type BogieKind = "own" | "jacobs";
export type NoseShape = "streamlined" | "wedge" | "rounded" | "blunt" | "cab_car" | "locomotive";
export type LiveryRole =
  | "body"
  | "upper_body"
  | "lower_body"
  | "window_band"
  | "stripe"
  | "doors"
  | "accent"
  | "skirt"
  | "mask"
  | "roof";

/** A cab front measured from a licensed view; see Front in pipelines/catalog vehicles.py. */
export interface FrontInput {
  readonly source: string;
  readonly view_source?: string | null;
  readonly length_m: number;
  readonly tip_height_m: number;
  readonly face_top_m?: number | null;
  readonly bottom_m?: number | null;
  readonly bottom_setback_m: number;
  readonly screen_bottom_m: number;
  readonly screen_top_m: number;
  readonly screen_bottom_setback_m: number;
  readonly screen_top_setback_m: number;
  readonly screen_width: number;
  readonly plan: "pointed" | "round" | "flat";
  readonly plan_exponents?: readonly [number, number] | null;
  readonly straight_m?: number;
  readonly mask_bottom_m?: number | null;
  readonly mask_top_m?: number | null;
  readonly mask_width?: number | null;
  readonly lamp_bottom_m?: number | null;
  readonly lamp_top_m?: number | null;
  readonly lamp_inner?: number | null;
  readonly lamp_outer?: number | null;
  readonly skirt_top_m?: number | null;
  readonly front_skirt_top_m?: number | null;
  readonly stripe?: "across" | "sides" | "dive" | "none";
  readonly stripe_bottom_m?: number | null;
  readonly stripe_top_m?: number | null;
  readonly front_stripe_bottom_m?: number | null;
  readonly front_stripe_top_m?: number | null;
  readonly cab_window?: boolean;
  readonly side_window_from_m?: number | null;
  readonly side_window_to_m?: number | null;
  readonly cab_length_m?: number | null;
  readonly loft?: FrontLoftInput | null;
  readonly face_bulge_m?: number | null;
  readonly screen_widths?: readonly (readonly [number, number])[] | null;
  readonly side_profile?: readonly (readonly [number, number])[] | null;
  readonly profile_by_height?: readonly (readonly [number, number])[] | null;
  readonly plan_widths?: readonly (readonly [number, number])[] | null;
  readonly tip_gap_m?: number | null;
  readonly stripe_curve?: readonly (readonly [number, number, number])[] | null;
  readonly chin_bottom_m?: number | null;
  readonly chin_top_m?: number | null;
  readonly chin_width?: number | null;
  readonly cheeks?: {
    readonly bottom_m: number;
    readonly top_m: number;
    readonly inner: number;
    readonly outer: number;
    readonly reach_m: number;
    readonly recess_m: number;
  } | null;
  readonly band_curve?: readonly (readonly [number, number, number])[] | null;
  readonly cab_glass_curve?: readonly (readonly [number, number, number])[] | null;
  readonly band_from_curve_start?: boolean | null;
  readonly lettering?: {
    readonly text: string;
    readonly from_m: number;
    readonly to_m: number;
    readonly bottom_m: number;
    readonly top_m: number;
    readonly italic?: number;
    readonly stripe_gap_m?: readonly [number, number] | null;
  } | null;
  readonly plain_cab_side?: boolean | null;
  readonly screen_round?: number | null;
  readonly screen_columns?: boolean | null;
  readonly screen_tone?: "dark" | "light";
  readonly mask_slot?: "mask" | "equipment" | null;
  readonly buffers?: boolean | null;
  readonly decals?: readonly FrontDecalInput[] | null;
  readonly side_window_bottom_m?: number | null;
  readonly side_window_top_m?: number | null;
  readonly side_window_round_m?: number | null;
  readonly side_window_rake?: number | null;
  readonly estimated?: readonly string[];
}

/** A pane on the front: lamp, grille, logo or dark field; see FrontDecal in vehicles.py. */
export interface FrontDecalInput {
  readonly slot:
    | "light"
    | "mask"
    | "window"
    | "stripe"
    | "accent"
    | "equipment"
    | "doors"
    | "lower_body"
    | "skirt"
    | "upper_body"
    | "display"
    | "housing"
    | "glass";
  readonly bottom_m: number;
  readonly top_m: number;
  readonly inner: number;
  readonly outer: number;
  readonly round?: number;
  readonly slant?: number;
  readonly under?: boolean;
  readonly tilt_deg?: number;
  readonly tail?: number | null;
  readonly tail_side?: "outer" | "inner" | "below";
  readonly tail_mode?: "separate" | "combined";
  readonly fill?: boolean;
  readonly lens_margin_m?: number;
  readonly logo?: boolean;
  readonly logo_red_letters?: boolean;
  readonly seam?: boolean;
  readonly clear_lens?: "inner" | "outer";
}

export interface FrontLoftInput {
  readonly waist_m: number;
  readonly top_m: number;
  readonly bottom_m: number;
  readonly exponent: number;
  readonly taper: number;
  readonly widths?: readonly (readonly [number, number])[] | null;
}

export interface CarTypeInput {
  readonly car_type: string;
  readonly name: string;
  readonly role: CarRole;
  readonly length_m?: number | null;
  readonly width_m?: number | null;
  readonly height_m?: number | null;
  readonly floor_height_m?: number | null;
  readonly double_deck: boolean;
  readonly lower_deck_floor_m?: number | null;
  readonly bogies: readonly [BogieKind, BogieKind];
  readonly bogie_pitch_m?: number | null;
  readonly bogie_offset_m?: number | null;
  readonly bogie_wheelbase_m?: number | null;
  readonly jacobs_wheelbase_m?: number | null;
  readonly wheel_diameter_m?: number | null;
  readonly nose_shape?: NoseShape | null;
  readonly nose_length_m?: number | null;
  readonly front?: FrontInput | null;
  readonly doors_per_side?: number | null;
  readonly door_positions_m?: readonly number[] | null;
  readonly door_width_m?: number | null;
  readonly window_sill_m?: number | null;
  readonly window_top_m?: number | null;
  readonly window_width_m?: number | null;
  readonly window_pillar_m?: number | null;
  readonly tumblehome_m?: number | null;
  readonly body_bottom_m?: number | null;
  readonly bogie_skirt_m?: number | null;
  readonly roof_exponent?: number | null;
  readonly window_pillars?: "band" | "body" | "mask" | null;
  readonly pantograph_count?: number | null;
  readonly pantograph_positions_m?: readonly number[] | null;
  readonly roof_equipment_m?: readonly (readonly [number, number])[] | null;
  readonly side_panels_m?: readonly (readonly [number, number, number, number])[] | null;
  readonly source: string;
  readonly field_sources?: Readonly<Record<string, string>>;
  readonly missing?: Readonly<Record<string, string>>;
}

export interface FormationInput {
  readonly car_type: string;
  readonly reversed?: boolean;
}

export interface VehicleInput {
  readonly model_id: string;
  readonly name: string;
  readonly series_id?: string | null;
  readonly generic: boolean;
  readonly category: string;
  readonly livery_id?: string | null;
  readonly unit_length_m?: number | null;
  readonly length_gap_reason?: string | null;
  readonly formation: readonly FormationInput[];
  readonly car_types: readonly CarTypeInput[];
  readonly source: string;
  readonly field_sources?: Readonly<Record<string, string>>;
  readonly missing?: Readonly<Record<string, string>>;
}

export interface LiveryColourInput {
  readonly role: LiveryRole;
  readonly name: string;
  readonly ral?: string | null;
  readonly hex?: string | null;
  readonly source: string;
  readonly hex_source?: string | null;
}

export interface LiveryInput {
  readonly livery_id: string;
  readonly name: string;
  readonly operator_id?: string | null;
  readonly series_ids?: readonly string[];
  /** Operators besides `operator_id` whose trains of these series wear the livery too. */
  readonly also_operator_ids?: readonly string[];
  readonly lines?: readonly string[];
  readonly valid_from?: string | Date | null;
  readonly valid_to?: string | Date | null;
  readonly colours: readonly LiveryColourInput[];
  readonly source: string;
}

/** An operator's Wikidata item and its parent organisations; see Operator in pipelines/catalog models.py. */
export interface OperatorInput {
  readonly operator_id: string;
  readonly wikidata_qid?: string | null;
  readonly parents?: readonly { readonly name: string; readonly wikidata_qid?: string | null }[];
}

export interface CatalogInput {
  readonly vehicles: readonly VehicleInput[];
  readonly liveries: readonly LiveryInput[];
  readonly operators?: readonly OperatorInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(text: string, file: string): Record<string, unknown>[] {
  const parsed: unknown = load(text);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`${file}: expected a list of rows`);
  }
  return parsed;
}

function requireKeys(row: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of keys) {
    if (!(key in row)) throw new Error(`${where}: missing ${key}`);
  }
}

/** Parses vehicles.yaml with the structural checks the forge relies on; gerlines-catalog validates the rest. */
export function parseVehicles(text: string): VehicleInput[] {
  return rows(text, "vehicles.yaml").map((row, index) => {
    const where = `vehicles.yaml[${index}]`;
    requireKeys(
      row,
      ["model_id", "generic", "category", "formation", "car_types", "source"],
      where,
    );
    const carTypes = row.car_types;
    if (!Array.isArray(carTypes) || carTypes.length === 0)
      throw new Error(`${where}: no car_types`);
    for (const car of carTypes) {
      if (!isRecord(car)) throw new Error(`${where}: car type is not a mapping`);
      requireKeys(car, ["car_type", "role", "bogies", "double_deck"], where);
    }
    return row as unknown as VehicleInput;
  });
}

export function parseLiveries(text: string): LiveryInput[] {
  return rows(text, "liveries.yaml").map((row, index) => {
    requireKeys(row, ["livery_id", "colours"], `liveries.yaml[${index}]`);
    return row as unknown as LiveryInput;
  });
}

export function parseOperators(text: string): OperatorInput[] {
  return rows(text, "operators.yaml").map((row, index) => {
    requireKeys(row, ["operator_id"], `operators.yaml[${index}]`);
    return row as unknown as OperatorInput;
  });
}

export function readCatalog(folder: string): CatalogInput {
  const operators = join(folder, "operators.yaml");
  return {
    vehicles: parseVehicles(readFileSync(join(folder, "vehicles.yaml"), "utf8")),
    liveries: parseLiveries(readFileSync(join(folder, "liveries.yaml"), "utf8")),
    ...(existsSync(operators)
      ? { operators: parseOperators(readFileSync(operators, "utf8")) }
      : {}),
  };
}
