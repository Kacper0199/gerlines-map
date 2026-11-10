import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TrainDetail } from "@gerlines/schema";
import { normalizePlatform } from "@gerlines/schema/platform";
import { describe, expect, it } from "vitest";
import { routeProduct } from "./product.ts";

const dir = join(import.meta.dirname, "fixtures");
const fixtures = new Map(
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as { detail: unknown };
      return [name.replace(/\.json$/, ""), TrainDetail.parse(doc.detail)] as const;
    }),
);

function fixture(name: string): TrainDetail {
  const detail = fixtures.get(name);
  if (!detail) throw new Error(`no fixture ${name}`);
  return detail;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("fixtures from real rows (gerlines_wp32b, 2026-10-27 02:57:40Z)", () => {
  it("all parse with the TrainDetail schema and hold no empty string", () => {
    expect(fixtures.size).toBe(8);
    for (const detail of fixtures.values()) {
      expect(strings(detail).filter((text) => text.trim() === "")).toEqual([]);
    }
  });

  it("name the product of every train whose route or trip names one", () => {
    for (const [name, detail] of fixtures) {
      if (routeProduct(detail.line) !== null || detail.category === "hsr") {
        expect(detail.productName, name).not.toBeNull();
      }
    }
    expect(fixture("ice-619-realtime")).toMatchObject({
      productName: "ICE",
      line: "42",
      trainNumber: "619",
    });
    expect(fixture("nj-403-foreign-night").productName).toBe("NJ");
    expect(fixture("night-91n-no-product").productName).toBeNull();
  });

  it("name stops with their town and show platforms as on the sign", () => {
    const ice = fixture("ice-619-realtime");
    expect(ice.stops.map((stop) => stop.name)).toContain("Stuttgart Hbf");
    expect(ice.stops.map((stop) => stop.name)).not.toContain("Hauptbahnhof");
    const platforms = [...fixtures.values()].flatMap((detail) =>
      detail.stops.flatMap((stop) => [stop.platformScheduled, stop.platformActual]),
    );
    expect(
      platforms.filter(
        (value) => value !== null && !/^\d{1,3}[a-z]?(-\d{1,3}[a-z]?)?$|^[A-H]$/i.test(value),
      ),
    ).toEqual([]);
    expect(platforms.filter((platform) => platform !== null).length).toBeGreaterThan(50);
    for (const platform of platforms) expect(normalizePlatform(platform)).toBe(platform);
  });

  it("keep no data apart from zero", () => {
    const timetable = fixture("ice-1540-timetable");
    expect(timetable.provenance.kind).toBe("timetable");
    expect(timetable.delaySeconds).toBeNull();
    expect(timetable.stops.every((stop) => stop.arrivalDelaySeconds === null)).toBe(true);
    expect(fixture("ice-619-realtime").delaySeconds).toBe(600);
  });

  it("carry the source's holders and licence, and the operator's brand and Wikidata id", () => {
    const ice = fixture("ice-619-realtime");
    expect(ice.provenance).toMatchObject({
      kind: "realtime",
      sourceId: "gtfsde-rt",
      holders: [
        { name: "DELFI e.V.", role: "publisher" },
        { name: "GTFS.de", role: "aggregator" },
      ],
      licence: { id: "CC-BY-SA-4.0" },
    });
    expect(ice.operator).toEqual({
      id: "db-fernverkehr-ag",
      name: "DB Fernverkehr",
      wikidataQid: "Q452140",
    });
    expect(
      fixture("rb27-17150-platforms").provenance.holders?.map((holder) => holder.role),
    ).toEqual(["publisher", "mirror"]);
  });

  it("show cancelled stops, added trips and foreign trains as they are", () => {
    const re3 = fixture("re3-3341-cancelled-stops");
    expect(re3.stops.filter((stop) => stop.cancelled).length).toBe(22);
    expect(re3.cancelled).toBe(false);
    expect(fixture("added-trip")).toMatchObject({ added: true, category: "other", line: null });
    expect(fixture("ic-82170-foreign-pkp")).toMatchObject({ foreign: true, productName: "IC" });
  });
});
