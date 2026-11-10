import { describe, expect, it } from "vitest";
import {
  keyOperatorId,
  keyTrainNumber,
  operatorNameOf,
  trainKeyOf,
  trainKeyOfDetail,
} from "./vehicle-resolver.ts";

const named = (id: string) => id !== "op-unnamed";

describe("the resolver key of a train", () => {
  it("takes the instance's operator before the trip's", () => {
    expect(keyOperatorId("op-instance", "op-route", named)).toBe("op-instance");
    expect(keyOperatorId(null, "op-route", named)).toBe("op-route");
    expect(keyOperatorId(null, null, named)).toBeNull();
  });

  it("keys on no operator when the catalogue has no name for it", () => {
    expect(keyOperatorId("op-unnamed", "op-route", named)).toBeNull();
  });

  it("names an operator by its brand, else its name, blank as none", () => {
    expect(operatorNameOf({ brandName: " S-Bahn München ", name: "DB Regio" })).toBe(
      "S-Bahn München",
    );
    expect(operatorNameOf({ brandName: "  ", name: "DB Regio" })).toBe("DB Regio");
    expect(operatorNameOf({ brandName: null, name: " " })).toBeNull();
  });

  it("takes the instance's train number before the trip's short name, one to six digits", () => {
    expect(keyTrainNumber("0612", "999")).toBe("612");
    expect(keyTrainNumber(null, " 006196 ")).toBe("6196");
    expect(keyTrainNumber(null, "000")).toBe("0");
    expect(keyTrainNumber(null, "1234567")).toBeNull();
    expect(keyTrainNumber("RE 5", "4711")).toBeNull();
    expect(keyTrainNumber(null, null)).toBeNull();
  });

  it("builds the same key from the timetable fields and from the train card", () => {
    const key = trainKeyOf(
      {
        serviceDate: "2026-11-08",
        category: "sbahn",
        line: "S1",
        instanceOperatorId: "op-instance",
        tripOperatorId: "op-route",
        instanceTrainNumber: "0",
        tripShortName: "6196",
      },
      named,
    );
    expect(key).toEqual({
      serviceDate: "2026-11-08",
      operatorId: "op-instance",
      category: "sbahn",
      line: "S1",
      trainNumber: "0",
    });
    expect(
      trainKeyOfDetail({
        serviceDate: "2026-11-08",
        category: "sbahn",
        line: "S1",
        operator: { id: "op-instance", name: "S-Bahn", wikidataQid: null },
        trainNumber: "0",
      }),
    ).toEqual(key);
  });
});
