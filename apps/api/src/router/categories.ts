export const CATEGORY_CODES = [
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
  "urban",
  "bus",
  "other",
] as const;

export type CategoryCode = (typeof CATEGORY_CODES)[number];

export const TRAIN_CATEGORY_CODES = [
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
] as const satisfies readonly CategoryCode[];

const MOTIS_CLASSES: Readonly<Record<CategoryCode, readonly string[]>> = {
  hsr: ["HIGHSPEED_RAIL"],
  ld: ["LONG_DISTANCE"],
  night: ["NIGHT_RAIL"],
  rfast: ["REGIONAL_RAIL"],
  reg: ["REGIONAL_RAIL"],
  sbahn: ["SUBURBAN"],
  urban: ["SUBWAY", "TRAM", "FUNICULAR"],
  bus: ["BUS", "COACH"],
  other: ["FERRY", "FUNICULAR", "AERIAL_LIFT", "OTHER"],
};

const FAST_REGIONAL_PREFIXES = new Set([
  "RE",
  "IRE",
  "MEX",
  "FEX",
  "RX",
  "REX",
  "HBX",
  "EX",
  "E",
  "IR",
  "SP",
  "RR",
]);

const ENRICHED_RAIL_TYPES: ReadonlyMap<number, CategoryCode> = new Map([
  [101, "hsr"],
  [102, "ld"],
  [105, "night"],
  [109, "sbahn"],
]);

const MODE_CATEGORY: Readonly<Record<string, CategoryCode>> = {
  HIGHSPEED_RAIL: "hsr",
  LONG_DISTANCE: "ld",
  NIGHT_RAIL: "night",
  SUBURBAN: "sbahn",
  METRO: "sbahn",
  SUBWAY: "urban",
  TRAM: "urban",
  BUS: "bus",
  COACH: "bus",
};

const NAME_PREFIX = /^\p{L}+/u;

export interface LegIdentity {
  readonly routeType?: number | undefined;
  readonly mode?: string | undefined;
  readonly displayName?: string | undefined;
  readonly agencyName?: string | undefined;
}

function namePrefix(name: string | undefined): string {
  return name?.trim().match(NAME_PREFIX)?.[0]?.toUpperCase() ?? "";
}

function regionalByName(name: string | undefined): CategoryCode {
  return FAST_REGIONAL_PREFIXES.has(namePrefix(name)) ? "rfast" : "reg";
}

function isRegionalRailType(routeType: number): boolean {
  return routeType === 2 || routeType === 100 || routeType === 103 || routeType === 106;
}

function categoryOfRouteType(
  routeType: number,
  name: string | undefined,
): CategoryCode | undefined {
  const rail = ENRICHED_RAIL_TYPES.get(routeType);
  if (rail) {
    return rail;
  }
  if (isRegionalRailType(routeType)) {
    return regionalByName(name);
  }
  if (
    [0, 1, 5, 7, 12].includes(routeType) ||
    (routeType >= 400 && routeType <= 405) ||
    (routeType >= 900 && routeType <= 906)
  ) {
    return "urban";
  }
  if (
    [3, 11, 800].includes(routeType) ||
    (routeType >= 200 && routeType <= 209) ||
    (routeType >= 700 && routeType <= 716)
  ) {
    return "bus";
  }
  if ([4, 6].includes(routeType) || (routeType >= 1000 && routeType <= 1702)) {
    return "other";
  }
  return undefined;
}

function categoryOfMode(mode: string | undefined, name: string | undefined): CategoryCode {
  if (mode === "REGIONAL_RAIL" || mode === "REGIONAL_FAST_RAIL" || mode === "RAIL") {
    return regionalByName(name);
  }
  return (mode && MODE_CATEGORY[mode]) || "other";
}

export function categoryOfLeg(leg: LegIdentity): CategoryCode {
  const byType =
    leg.routeType === undefined ? undefined : categoryOfRouteType(leg.routeType, leg.displayName);
  return byType ?? categoryOfMode(leg.mode, leg.displayName);
}

export function isFlixTrain(leg: LegIdentity): boolean {
  return namePrefix(leg.displayName) === "FLX" || /flix/i.test(leg.agencyName ?? "");
}

export function transitModesFor(categories: readonly CategoryCode[]): string[] | undefined {
  if (CATEGORY_CODES.every((code) => categories.includes(code))) {
    return undefined;
  }
  const modes = new Set<string>();
  for (const code of CATEGORY_CODES) {
    if (categories.includes(code)) {
      for (const mode of MOTIS_CLASSES[code]) {
        modes.add(mode);
      }
    }
  }
  return [...modes];
}
