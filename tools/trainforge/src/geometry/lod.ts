export type LodLevel = 0 | 1 | 2;

export interface LodSettings {
  readonly level: LodLevel;
  readonly roofSegments: number;
  readonly lowerSegments: number;
  /** Paint edges the front carries: every edge, the bands and windscreen, or the windscreen only. */
  readonly noseLevels: "full" | "band" | "none";
  /** Raised body over the bogies of low-floor and double-deck cars. */
  readonly zones: boolean;
  readonly recessedOpenings: boolean;
  /** Doors as openings in the side wall, and the cab side window. */
  readonly doors: boolean;
  readonly cabWindows: boolean;
  readonly separateWindows: boolean;
  readonly doorWindows: boolean;
  readonly stripe: boolean;
  /** The stripe edges are rows of the front too, so the stripe runs round the cab. */
  readonly frontStripe: boolean;
  readonly wheelSegments: number;
  readonly bogieDetail: "full" | "box" | "block";
  readonly roofEquipment: boolean;
  readonly pantographDetail: "full" | "bar" | "none";
  readonly underframe: boolean;
  readonly gangway: boolean;
}

export const LODS: readonly LodSettings[] = [
  {
    level: 0,
    roofSegments: 6,
    lowerSegments: 3,
    noseLevels: "full",
    zones: true,
    recessedOpenings: true,
    doors: true,
    cabWindows: true,
    separateWindows: true,
    doorWindows: true,
    stripe: true,
    frontStripe: true,
    wheelSegments: 10,
    bogieDetail: "full",
    roofEquipment: true,
    pantographDetail: "full",
    underframe: true,
    gangway: true,
  },
  {
    level: 1,
    roofSegments: 4,
    lowerSegments: 2,
    noseLevels: "band",
    zones: true,
    recessedOpenings: false,
    doors: true,
    cabWindows: true,
    separateWindows: true,
    doorWindows: true,
    stripe: true,
    frontStripe: true,
    wheelSegments: 4,
    bogieDetail: "box",
    roofEquipment: true,
    pantographDetail: "bar",
    underframe: true,
    gangway: true,
  },
  {
    level: 2,
    roofSegments: 2,
    lowerSegments: 1,
    noseLevels: "none",
    zones: false,
    recessedOpenings: false,
    doors: false,
    cabWindows: false,
    separateWindows: false,
    doorWindows: false,
    stripe: true,
    frontStripe: true,
    wheelSegments: 0,
    bogieDetail: "block",
    roofEquipment: false,
    pantographDetail: "none",
    underframe: false,
    gangway: false,
  },
];

/** Triangle budgets per car (body plus two bogies), LOD0 raised to 6,000 by D-045. */
export const CAR_BUDGET: Readonly<Record<LodLevel, number>> = { 0: 6000, 1: 1200, 2: 300 };
