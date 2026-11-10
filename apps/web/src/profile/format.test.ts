import { profileCopyFor } from "@gerlines/i18n/profile";
import { StatsTrainSegments } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import detail from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import answerJson from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { describeLeg, minutesText } from "./format.ts";
import { buildProfileLegs, type ProfileLeg } from "./model.ts";

const stops = detail.detail.stops as { stopPlaceId: string; name: string }[];
const answer = StatsTrainSegments.parse(answerJson);
const { legs } = buildProfileLegs(stops, answer, Float32Array.from(stops.map((_, i) => i)));
const copy = profileCopyFor("en").profile;
const unit = profileCopyFor("en").delay.minutes;
const legAt = (index: number): ProfileLeg => {
  const found = legs[index];
  if (!found) throw new Error(`no leg ${index}`);
  return found;
};
const describe_ = (index: number, quantile: "median" | "p80" = "median", locale = "en") =>
  describeLeg(legAt(index), quantile, copy, unit, locale);

describe("minutesText", () => {
  it("shows seconds as minutes with at most one decimal and the unit", () => {
    expect(minutesText(60, "en", unit)).toBe(`1 ${unit}`);
    expect(minutesText(0, "en", unit)).toBe(`0 ${unit}`);
    expect(minutesText(-120, "en", unit)).toBe(`-2 ${unit}`);
    expect(minutesText(90, "en", unit)).toBe(`1.5 ${unit}`);
    expect(minutesText(90, "de", unit)).toBe(`1,5 ${unit}`);
  });
});

describe("describeLeg", () => {
  it("names the two stops and gives this train and all trains the figures the API sent", () => {
    const api = answer.segments[2];
    if (api?.train.status !== "known" || api.all.status !== "known") throw new Error("fixture");
    const text = describe_(2);
    expect(text.title).toBe("Hamburg Hbf to Hamburg-Harburg");
    expect(profileCopyFor("pl").profile.leg("A", "B")).toBe("A do B");
    expect(text.known).toBe(true);
    const [thisTrain, allTrains] = text.lines;
    expect(thisTrain).toEqual({
      label: copy.tooltip.thisTrain,
      value: `${copy.tooltip.figures(minutesText(api.train.medianGainS, "en", unit), minutesText(api.train.p80GainS, "en", unit))}, ${copy.runs(api.train.runs)}`,
    });
    expect(allTrains?.label).toBe(copy.tooltip.allTrains);
    expect(allTrains?.value).toContain(copy.runs(api.all.runs));
  });

  it("adds the difference to all trains for the chosen measure", () => {
    const text = describe_(14);
    const last = text.lines.at(-1);
    expect(last?.label).toBe(copy.measure.median);
    expect(last?.value).toBe(copy.tooltip.diffMore(minutesText(120, "en", unit)));
    expect(describe_(14, "p80").lines.at(-1)?.label).toBe(copy.measure.p80);
  });

  it("says why a leg has no figures and keeps the figures of the other side", () => {
    const text = describe_(3);
    expect(text.known).toBe(false);
    expect(text.lines[0]).toEqual({
      label: copy.tooltip.thisTrain,
      value: copy.reason.tooFew("3", "5"),
    });
    expect(text.lines[1]?.label).toBe(copy.tooltip.allTrains);
    expect(text.lines).toHaveLength(2);
  });

  it("gives each reason its own words", () => {
    expect(describe_(10).lines[0]?.value).toBe(copy.reason.noRuns);
    const absent = describeLeg(
      {
        ...legAt(10),
        train: { status: "missing", runs: 0, reason: "not_in_profile" },
        all: { status: "missing", runs: 0, reason: "not_in_profile" },
      },
      "median",
      copy,
      unit,
      "en",
    );
    expect(absent.lines.map((line) => line.value)).toEqual([
      copy.reason.notInProfile,
      copy.reason.notInProfile,
    ]);
  });
});
