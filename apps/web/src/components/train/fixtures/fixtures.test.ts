import { TrainDetail } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import { buildCardModel } from "../model.ts";
import { TRAIN_FIXTURES } from "./index.ts";

const REQUIRED = [
  "ice-delay",
  "platform-change",
  "re-timetable",
  "sbahn-on-time",
  "cancelled-stop",
  "cancelled-train",
  "long-names",
  "foreign",
];

describe("train card fixtures from the replay database", () => {
  it("has every state the card must show", () => {
    expect(Object.keys(TRAIN_FIXTURES)).toEqual(expect.arrayContaining(REQUIRED));
  });

  it.each(Object.values(TRAIN_FIXTURES).map((f) => [f.fixture.name, f] as const))(
    "%s passes the contract and names its origin",
    (_name, { fixture, detail }) => {
      expect(TrainDetail.safeParse(detail).success).toBe(true);
      expect(fixture.database).toMatch(/^gerlines_/);
      expect(fixture.selection.length).toBeGreaterThan(0);
      expect(detail.asOf).toBe(fixture.asOf);
      expect(detail.vehicle).toBeNull();
      expect(detail.photo).toBeNull();
    },
  );

  it.each(Object.values(TRAIN_FIXTURES).map((f) => [f.fixture.name, f] as const))(
    "%s records how it was built and that it cannot be rebuilt as is",
    (_name, { fixture, detail }) => {
      const asOf = Date.parse(fixture.asOf);
      expect(Date.parse(fixture.replay.from ?? "")).toBeLessThanOrEqual(asOf);
      expect(Date.parse(fixture.replay.to ?? "")).toBeGreaterThanOrEqual(asOf);
      expect(fixture.feedVersions.map((v) => v.version)).toContain(detail.timetableVersion);
      expect(fixture.rtPayloads.atOrBefore).toBe(fixture.asOf);
      expect(fixture.rtPayloads.total).toBeGreaterThan(0);
      if (detail.provenance.kind !== "timetable") {
        expect(fixture.rtPayloads.bySource[detail.provenance.sourceId]).toBeGreaterThan(0);
      }
      expect(fixture.builder.script).toBe("apps/web/src/components/train/fixtures/build.ts");
      expect(fixture.builder.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.assumed.some((line) => line.startsWith("detail.geometry.available"))).toBe(
        true,
      );
      expect(detail.geometry.available).toBe(true);
      expect(fixture.rebuildable).toBe(false);
      expect(fixture.rebuildNote.length).toBeGreaterThan(0);
    },
  );

  it("shows each state at its own instant", () => {
    const model = (name: string) => {
      const fixture = TRAIN_FIXTURES[name];
      if (!fixture) throw new Error(`missing ${name}`);
      return buildCardModel(fixture.detail, Date.parse(fixture.detail.asOf));
    };
    expect(Math.abs(model("ice-delay").delayMinutes ?? 0)).toBeGreaterThanOrEqual(5);
    expect(model("ice-delay").category).toBe("hsr");
    const platform = model("platform-change");
    const position = platform.position;
    const next =
      position.kind === "between" ? position.to : position.kind === "at" ? position.stop : null;
    expect(next?.platform?.was).toEqual(expect.any(String));
    expect(model("re-timetable").realtime).toBe(false);
    expect(model("sbahn-on-time").delayMinutes).toBe(0);
    const cancelledStop = model("cancelled-stop");
    expect(cancelledStop.stops.some((stop) => stop.cancelled && stop.role === "ahead")).toBe(true);
    expect(model("cancelled-train").position.kind).toBe("cancelled");
    expect(model("foreign").category).toBe("foreign");
    expect(
      Math.max(...model("long-names").stops.map((stop) => stop.name.length)),
    ).toBeGreaterThanOrEqual(30);
  });
});
