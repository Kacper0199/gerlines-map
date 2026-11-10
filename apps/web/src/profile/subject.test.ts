import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import ice from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import { profileSubjectOf } from "./subject.ts";

const detail = TrainDetail.parse(ice.detail);

describe("profileSubjectOf", () => {
  it("names the number, the category, the operator and the stops of a train the map draws", () => {
    const subject = profileSubjectOf(detail, true);
    expect(subject).toMatchObject({
      number: "619",
      category: "hsr",
      operatorId: "db-fernverkehr-ag",
    });
    expect(subject?.stops).toHaveLength(22);
    expect(subject?.stops[0]).toMatchObject({
      stopPlaceId: detail.stops[0]?.stopPlaceId,
      name: "Hamburg-Altona",
      cancelled: false,
    });
    expect(subject?.stops[0]?.times).toEqual([Date.parse("2026-10-26T18:25:00.000Z") / 1000]);
    expect(subject?.stops[2]?.times).toEqual(
      ["2026-10-26T18:37:00.000Z", "2026-10-26T18:44:00.000Z", "2026-10-26T18:51:00.000Z"].map(
        (iso) => Date.parse(iso) / 1000,
      ),
    );
  });

  it("is absent when the map does not draw the train or the train has no number", () => {
    expect(profileSubjectOf(detail, false)).toBeNull();
    expect(profileSubjectOf({ ...detail, trainNumber: null }, true)).toBeNull();
  });
});
