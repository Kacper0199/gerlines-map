import { describe, expect, it } from "vitest";
import { CATEGORY_CODES, categoryOfLeg, isFlixTrain, transitModesFor } from "./categories.ts";

describe("categoryOfLeg", () => {
  it.each([
    [101, "HIGHSPEED_RAIL", "29", "hsr"],
    [102, "LONG_DISTANCE", "IC", "ld"],
    [105, "NIGHT_RAIL", "NJ", "night"],
    [109, "SUBURBAN", "S2", "sbahn"],
    [106, "REGIONAL_RAIL", "RB6", "reg"],
    [106, "REGIONAL_RAIL", "RE1", "rfast"],
    [106, "REGIONAL_RAIL", "IRE 3", "rfast"],
    [106, "REGIONAL_RAIL", "FEX", "rfast"],
    [106, "REGIONAL_RAIL", "E", "rfast"],
    [106, "REGIONAL_RAIL", "50", "reg"],
    [400, "SUBWAY", "U5", "urban"],
    [0, "TRAM", "M10", "urban"],
    [900, "TRAM", "1", "urban"],
    [700, "BUS", "100", "bus"],
    [714, "BUS", "SEV", "bus"],
    [3, "BUS", "X", "bus"],
    [201, "COACH", "FLX", "bus"],
    [1000, "FERRY", "F10", "other"],
    [7, "FUNICULAR", "Merkurbergbahn", "urban"],
    [1400, "FUNICULAR", "Standseilbahn", "other"],
  ] as const)("route type %i with mode %s and name %s is %s", (routeType, mode, name, code) => {
    expect(categoryOfLeg({ routeType, mode, displayName: name })).toBe(code);
  });

  it("trusts the route type over the mode MOTIS gives a mixed stay-seated block", () => {
    expect(categoryOfLeg({ routeType: 105, mode: "LONG_DISTANCE", displayName: "43N" })).toBe(
      "night",
    );
    expect(categoryOfLeg({ routeType: 109, mode: "REGIONAL_RAIL", displayName: "S6" })).toBe(
      "sbahn",
    );
  });

  it("falls back to the MOTIS mode when the route type is missing or unknown", () => {
    expect(categoryOfLeg({ mode: "HIGHSPEED_RAIL", displayName: "ICE 1" })).toBe("hsr");
    expect(categoryOfLeg({ routeType: 9999, mode: "SUBURBAN", displayName: "S1" })).toBe("sbahn");
    expect(categoryOfLeg({ mode: "REGIONAL_RAIL", displayName: "RE7" })).toBe("rfast");
    expect(categoryOfLeg({ mode: "METRO", displayName: "S1" })).toBe("sbahn");
    expect(categoryOfLeg({ mode: "AERIAL_LIFT" })).toBe("other");
  });
});

describe("isFlixTrain", () => {
  it("recognises FlixTrain by line name or agency", () => {
    expect(isFlixTrain({ displayName: "FLX10" })).toBe(true);
    expect(isFlixTrain({ displayName: "10", agencyName: "FlixTrain" })).toBe(true);
    expect(isFlixTrain({ displayName: "IC", agencyName: "DB Fernverkehr AG" })).toBe(false);
  });
});

describe("transitModesFor", () => {
  it("asks MOTIS for every class of the chosen categories once", () => {
    expect(transitModesFor(["hsr", "ld", "rfast", "reg"])).toEqual([
      "HIGHSPEED_RAIL",
      "LONG_DISTANCE",
      "REGIONAL_RAIL",
    ]);
  });

  it("asks for funiculars with urban transport, since route type 7 is urban", () => {
    expect(transitModesFor(["urban"])).toEqual(["SUBWAY", "TRAM", "FUNICULAR"]);
    expect(transitModesFor(["other"])).toContain("FUNICULAR");
  });

  it("leaves the modes to MOTIS when every category is chosen", () => {
    expect(transitModesFor(CATEGORY_CODES)).toBeUndefined();
    expect(transitModesFor([...CATEGORY_CODES].reverse())).toBeUndefined();
  });

  it("never sends the deprecated METRO class", () => {
    const allButOne = CATEGORY_CODES.map((skipped) =>
      transitModesFor(CATEGORY_CODES.filter((code) => code !== skipped)),
    );
    for (const modes of allButOne) {
      expect(modes).toBeDefined();
      expect(modes).not.toContain("METRO");
    }
  });
});
