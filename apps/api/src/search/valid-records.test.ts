import { describe, expect, it } from "vitest";
import { runSliced } from "./slices.ts";
import { testData } from "./test-data.ts";
import { validating, validRecords } from "./valid-records.ts";

describe("validRecords", () => {
  it("keeps every record that meets the answer contract", () => {
    const data = testData();
    const { data: kept, dropped } = validRecords(data);
    expect(dropped).toEqual({ station: 0, train: 0, line: 0, place: 0 });
    expect(kept.stations).toHaveLength(data.stations.length);
    expect(kept.places).toHaveLength(data.places.length);
  });

  it("drops a record that would break every answer it matches, and counts it", () => {
    const data = testData();
    const [first, ...rest] = data.stations;
    if (!first) throw new Error("no station");
    const [place, ...places] = data.places;
    if (!place) throw new Error("no place");
    const { data: kept, dropped } = validRecords({
      ...data,
      stations: [
        { ...first, name: "" },
        { ...first, id: "x", eva: 0 },
        { ...first, dhid: "Köln Hbf" },
        ...rest,
      ],
      places: [{ ...place, names: { ...place.names, pl: " " } }, ...places],
    });
    expect(dropped).toMatchObject({ station: 3, place: 1 });
    expect(kept.stations).toHaveLength(rest.length);
    expect(kept.places).toHaveLength(places.length);
  });

  it("keeps a station whose feed stop id breaks the contract, without that stop id", () => {
    const data = testData();
    const [first, ...rest] = data.stations;
    if (!first) throw new Error("no station");
    const { data: kept, dropped } = validRecords({
      ...data,
      stations: [{ ...first, dhid: null, stopId: "ch:1:sloid 10?" }, ...rest],
    });
    expect(dropped.station).toBe(0);
    expect(kept.stations[0]).toMatchObject({ id: first.id, dhid: null, stopId: null });
  });
});

describe("validating", () => {
  it("pauses between slices and keeps and counts the same records as validRecords", async () => {
    const data = testData();
    let pauses = 0;
    const sliced = await runSliced(validating(data, 2), async () => {
      pauses += 1;
    });
    expect(pauses).toBeGreaterThan(3);
    expect(sliced).toEqual(validRecords(data));
  });
});
