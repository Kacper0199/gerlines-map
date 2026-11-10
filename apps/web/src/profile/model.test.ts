import { StatsTrainSegments } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import detail from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import answerJson from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { buildProfileLegs, legMeasure, type ProfileLeg } from "./model.ts";

const stops = detail.detail.stops as { stopPlaceId: string; name: string }[];
const answer = StatsTrainSegments.parse(answerJson);
const vertices = Float32Array.from(stops.map((_, i) => i * 10 + 0.5));

describe("buildProfileLegs", () => {
  it("makes one leg per pair of consecutive stops, in route order, with its vertices", () => {
    const { legs, placed } = buildProfileLegs(stops, answer, vertices);
    expect(placed).toBe(true);
    expect(legs).toHaveLength(stops.length - 1);
    expect(legs[0]).toMatchObject({
      index: 0,
      from: "Hamburg-Altona",
      to: "Hamburg Dammtor",
      fromVertex: 0.5,
      toVertex: 10.5,
    });
    expect(legs.at(-1)).toMatchObject({ from: "Augsburg Hbf", to: "München Hbf" });
  });

  it("takes the figures of the segment with the same two stop place ids, as the API sent them", () => {
    const { legs } = buildProfileLegs(stops, answer, vertices);
    const api = answer.segments[2];
    if (api?.train.status !== "known" || api.all.status !== "known") throw new Error("fixture");
    expect(legs[2]?.train).toEqual({
      status: "known",
      runs: api.train.runs,
      medianGainS: api.train.medianGainS,
      p80GainS: api.train.p80GainS,
    });
    expect(legs[2]?.all).toMatchObject({ status: "known", runs: api.all.runs });
  });

  it("keeps a leg with too few runs missing with its reason and run count", () => {
    const { legs } = buildProfileLegs(stops, answer, vertices);
    expect(legs[3]?.train).toEqual({ status: "missing", runs: 3, reason: "too_few_runs" });
  });

  it("keeps the reason the API gave for a leg this train did not run", () => {
    const { legs } = buildProfileLegs(stops, answer, vertices);
    expect(legs[10]?.train).toEqual({ status: "missing", runs: 0, reason: "no_runs" });
    expect(legs[10]?.all).toMatchObject({ status: "known" });
  });

  it("marks a pair the answer does not hold at all as not in the profile", () => {
    const without = { ...answer, segments: answer.segments.filter((s) => s.position !== 5) };
    const { legs } = buildProfileLegs(stops, without, vertices);
    expect(legs[5]?.train).toEqual({ status: "missing", runs: 0, reason: "not_in_profile" });
    expect(legs[5]?.all).toEqual({ status: "missing", runs: 0, reason: "not_in_profile" });
  });

  it("counts the legs whose station names are in the answer under other ids, and gives them no figures", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const renamed = {
      ...answer,
      segments: answer.segments.map((segment) =>
        segment.position === 5 ? { ...segment, from: { ...segment.from, id: other } } : segment,
      ),
    };
    const built = buildProfileLegs(stops, renamed, vertices);
    expect(built.legs[5]?.train).toEqual({ status: "missing", runs: 0, reason: "not_in_profile" });
    expect(built.sameNameOtherIds).toBe(1);
    expect(buildProfileLegs(stops, answer, vertices).sameNameOtherIds).toBe(0);
    const without = { ...answer, segments: answer.segments.filter((s) => s.position !== 5) };
    expect(buildProfileLegs(stops, without, vertices).sameNameOtherIds).toBe(0);
  });

  it("does not place the legs when the route has another number of stops", () => {
    const { legs, placed } = buildProfileLegs(stops, answer, vertices.subarray(1));
    expect(placed).toBe(false);
    expect(legs[0]?.fromVertex).toBeNull();
    expect(buildProfileLegs(stops, answer, undefined).placed).toBe(false);
  });
});

describe("legMeasure", () => {
  const { legs } = buildProfileLegs(stops, answer, vertices);
  const leg = (index: number) => legs[index] as ProfileLeg;

  it("compares this train with all trains by the chosen quantile, in minutes", () => {
    const m = legMeasure(leg(2), "median");
    if (m.status !== "known") throw new Error("known expected");
    expect(m.trainS).toBe(60);
    expect(m.differenceMinutes).toBe(0);
    expect(m.gain).toBe(0);
    expect(m.curtainMinutes).toBe(1);
    const p = legMeasure(leg(2), "p80");
    if (p.status !== "known") throw new Error("known expected");
    expect(p.trainS).toBe(120);
  });

  it("is red where the train loses more time than all trains and blue where it loses less", () => {
    const worse = legMeasure(leg(14), "median");
    const better = legMeasure(leg(11), "median");
    if (worse.status !== "known" || better.status !== "known") throw new Error("known expected");
    expect(worse.gain).toBeGreaterThan(0);
    expect(better.gain).toBeLessThanOrEqual(0);
    expect(better.curtainMinutes).toBe(0);
  });

  it("is missing with the reason of the side without figures", () => {
    expect(legMeasure(leg(3), "median")).toEqual({
      status: "missing",
      side: "train",
      reason: "too_few_runs",
      runs: 3,
    });
  });
});
