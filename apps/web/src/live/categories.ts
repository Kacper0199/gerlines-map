import type { Category, TripRecord } from "@gerlines/live-frame";
import type { CategoryKey } from "../motion/categories.ts";

const CATEGORY_KEYS: Readonly<Record<Category, CategoryKey | null>> = {
  unknown: null,
  hsr: "hsr",
  ld: "ld",
  night: "night",
  rfast: "rfast",
  reg: "reg",
  sbahn: "sbahn",
  urban: "sbahn",
  bus: null,
};

/**
 * The legend category a frame trip is drawn in. Foreign trains have their own colour whatever
 * their service and urban rail joins S-Bahn. A bus or a trip
 * without a category belongs to no legend category: it is not drawn and not counted under a named
 * one (the frames only hold rail, so these are rare), which is null here.
 */
export function categoryKeyOf(trip: Pick<TripRecord, "category" | "foreign">): CategoryKey | null {
  return trip.foreign ? "foreign" : CATEGORY_KEYS[trip.category];
}
