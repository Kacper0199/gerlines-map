import type { JourneyRemovalReason, LongDistanceProduct } from "@gerlines/schema/journeys";
import { type CategoryCode, categoryOfLeg, isFlixTrain } from "../router/categories.ts";
import type { MotisItinerary, MotisLeg } from "../router/motis.ts";

export interface FilterOptions {
  readonly categories: readonly CategoryCode[];
  readonly exclude: readonly LongDistanceProduct[];
  readonly operators: readonly string[];
  readonly avoidOperators: readonly string[];
}

export interface JourneyFilter {
  /** The first reason the itinerary is left out, or null when every leg passes. */
  removalReason(itinerary: MotisItinerary): JourneyRemovalReason | null;
  /** True when MOTIS cannot apply the filter itself, so a wider search is needed. */
  readonly postFilters: boolean;
}

export function isStreetLeg(leg: Pick<MotisLeg, "mode">): boolean {
  return leg.mode === "WALK" || leg.mode === "BIKE" || leg.mode === "CAR";
}

export function foldName(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches an operator whose name has a word starting with one of the terms (DB, Flix, metronom). */
export function operatorMatcher(
  terms: readonly string[],
): (operator: string | undefined) => boolean {
  const patterns = terms.map(
    (term) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldName(term.trim()))}`, "u"),
  );
  return (operator) => {
    if (!operator) {
      return false;
    }
    const folded = foldName(operator);
    return patterns.some((pattern) => pattern.test(folded));
  };
}

function productOf(leg: MotisLeg): LongDistanceProduct {
  return isFlixTrain(leg) ? "flx" : "ic";
}

export function createJourneyFilter({
  categories,
  exclude,
  operators,
  avoidOperators,
}: FilterOptions): JourneyFilter {
  const allowed = new Set(categories);
  const splitsLongDistance = exclude.length > 0 && allowed.has("ld");
  const splitsRegional = allowed.has("rfast") !== allowed.has("reg");
  const operatorFilter = operators.length > 0 || avoidOperators.length > 0;
  const included = operatorMatcher(operators);
  const avoided = operatorMatcher(avoidOperators);

  function legReason(leg: MotisLeg): JourneyRemovalReason | null {
    if (isStreetLeg(leg)) {
      return null;
    }
    const category = categoryOfLeg(leg);
    if (!allowed.has(category)) {
      return "category";
    }
    if (category === "ld" && exclude.includes(productOf(leg))) {
      return "product";
    }
    if (operators.length > 0 && !included(leg.agencyName)) {
      return "operator";
    }
    if (avoidOperators.length > 0 && avoided(leg.agencyName)) {
      return "operator";
    }
    return null;
  }

  const order: readonly JourneyRemovalReason[] = ["category", "product", "operator"];

  return {
    postFilters: splitsLongDistance || splitsRegional || operatorFilter,
    removalReason(itinerary) {
      const reasons = new Set(itinerary.legs.map(legReason));
      return order.find((reason) => reasons.has(reason)) ?? null;
    },
  };
}
