import { JOURNEY_CATEGORIES } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { CATEGORY_CODES } from "../router/categories.ts";
import { journeyQuerySchema, restoreTimeOffset } from "./query.ts";

const BASE = { from: "de:11000:900003201", to: "de:02000:10950" };

describe("journeyQuerySchema, WP-8.1 parameters", () => {
  it("uses the router's category codes in the shared contract", () => {
    expect([...JOURNEY_CATEGORIES]).toEqual([...CATEGORY_CODES]);
  });

  it("reads operator lists, trims them and drops duplicates", () => {
    const parsed = journeyQuerySchema.parse({
      ...BASE,
      operators: " DB Regio ,metronom,metronom",
      avoidOperators: "Flix",
    });
    expect(parsed.operators).toEqual(["DB Regio", "metronom"]);
    expect(parsed.avoidOperators).toEqual(["Flix"]);
  });

  it("accepts operator names with accents, digits, dots, ampersands and hyphens", () => {
    const parsed = journeyQuerySchema.parse({
      ...BASE,
      operators: "Österreichische Bundesbahnen,S-Bahn Hamburg,Go-Ahead,Bayerische Regiobahn 2,A&B.",
    });
    expect(parsed.operators).toHaveLength(5);
  });

  it("reads sort, results and maxChanges", () => {
    const parsed = journeyQuerySchema.parse({
      ...BASE,
      sort: "fewestChanges",
      results: "8",
      maxChanges: "0",
    });
    expect(parsed).toMatchObject({ sort: "fewestChanges", results: 8, maxChanges: 0 });
  });

  it("leaves sort and maxChanges unset by default and asks for five journeys", () => {
    const parsed = journeyQuerySchema.parse(BASE);
    expect(parsed.sort).toBeUndefined();
    expect(parsed.maxChanges).toBeUndefined();
    expect(parsed.results).toBe(5);
  });

  it.each([
    [{ operators: "D" }, "operators"],
    [{ operators: "DB,x" }, "operators"],
    [{ operators: "a,b,c,d,e,f".replace(/\w/g, "$&$&") }, "operators"],
    [{ operators: "x".repeat(41) }, "operators"],
    [{ operators: "DB;drop" }, "operators"],
    [{ operators: "(DB)" }, "operators"],
    [{ operators: ".DB" }, "operators"],
    [{ avoidOperators: "D" }, "avoidOperators"],
    [{ avoidOperators: "a|b" }, "avoidOperators"],
    [{ sort: "cheapest" }, "sort"],
    [{ sort: "FASTEST" }, "sort"],
    [{ results: "0" }, "results"],
    [{ results: "11" }, "results"],
    [{ results: "2.5" }, "results"],
    [{ results: "x" }, "results"],
    [{ maxChanges: "-1" }, "maxChanges"],
    [{ maxChanges: "9" }, "maxChanges"],
    [{ maxChanges: "one" }, "maxChanges"],
    [{ maxChanges: "" }, "maxChanges"],
    [{ results: "" }, "results"],
    [{ results: " 5" }, "results"],
  ])("rejects %j at %s", (input, path) => {
    const parsed = journeyQuerySchema.safeParse({ ...BASE, ...input });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(path);
  });
});

describe("restoreTimeOffset", () => {
  it("turns a plus decoded as a space back into the offset sign", () => {
    expect(restoreTimeOffset({ ...BASE, time: "2026-10-27T07:00:00 01:00" })).toEqual({
      ...BASE,
      time: "2026-10-27T07:00:00+01:00",
    });
  });

  it("leaves a Z time, a minus offset and a query without time alone", () => {
    expect(restoreTimeOffset({ ...BASE, time: "2026-10-27T06:00:00Z" }).time).toBe(
      "2026-10-27T06:00:00Z",
    );
    expect(restoreTimeOffset({ ...BASE, time: "2026-10-27T01:00:00-05:00" }).time).toBe(
      "2026-10-27T01:00:00-05:00",
    );
    expect(restoreTimeOffset(BASE)).toEqual(BASE);
  });
});

describe("results describes a minimum", () => {
  it("says at least in its description", () => {
    expect(journeyQuerySchema.shape.results.description).toMatch(/^At least /);
  });
});
