import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { IDENTICAL_BODY_TABLE } from "./identical-bodies.generated.ts";
import { relatedBody } from "./identical-bodies.ts";
import {
  type BodyRow,
  bodyTable,
  missingRelatedModels,
  type SeriesRow,
} from "./identical-body-rules.ts";

const catalogue = (name: string) =>
  load(readFileSync(resolve(import.meta.dirname, "../../../../catalog", name), "utf8"));

const SERIES: SeriesRow[] = [
  { series_id: "db-old", name: "DB Class Old" },
  { series_id: "db-new", name: "DB Class New" },
  { series_id: "db-other", name: "DB Class Other" },
];

const row = (overrides: Partial<BodyRow>): BodyRow => ({
  series_id: "db-old",
  related_series_id: "db-new",
  verdict: "accepted",
  ...overrides,
});

describe("bodyTable", () => {
  it("maps the series of an accepted row to the related series and its catalogue name", () => {
    expect(bodyTable([row({})], SERIES)).toEqual({
      "db-old": { relatedSeriesId: "db-new", relatedName: "DB Class New" },
    });
  });

  it("leaves rejected rows out", () => {
    expect(bodyTable([row({ verdict: "rejected" })], SERIES)).toEqual({});
  });

  it("refuses a related series the catalogue does not name", () => {
    expect(() => bodyTable([row({ related_series_id: "nowhere" })], SERIES)).toThrow(/nowhere/);
  });

  it("refuses a series the catalogue does not name", () => {
    expect(() => bodyTable([row({ series_id: "nobody" })], SERIES)).toThrow(/nobody/);
  });

  it("refuses two accepted rows for one series instead of keeping the last", () => {
    const rows = [row({}), row({ related_series_id: "db-other" })];
    expect(() => bodyTable(rows, SERIES)).toThrow(/db-old.*two accepted/);
  });
});

describe("missingRelatedModels", () => {
  const table = bodyTable([row({})], SERIES);

  it("lists the related series the forge has no model for", () => {
    expect(missingRelatedModels(table, ["db-other"])).toEqual(["db-new"]);
    expect(missingRelatedModels(table, ["db-new"])).toEqual([]);
    expect(missingRelatedModels({}, [])).toEqual([]);
  });
});

describe("relatedBody", () => {
  const table = bodyTable([row({})], SERIES);

  it("answers only for a series of the table", () => {
    expect(relatedBody("db-old", table)?.relatedName).toBe("DB Class New");
    expect(relatedBody("db-new", table)).toBeUndefined();
    expect(relatedBody(null, table)).toBeUndefined();
    expect(relatedBody(undefined, table)).toBeUndefined();
  });

  it("does not answer for the keys every object has", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(relatedBody(key, table), key).toBeUndefined();
    }
  });
});

const forgeSeries = (): Set<string> => {
  const models = load(
    readFileSync(resolve(import.meta.dirname, "../../../../catalog/vehicles.yaml"), "utf8"),
  ) as { series_id?: string; generic: boolean }[];
  const fromYaml = models
    .filter((m) => !m.generic && m.series_id)
    .map((m) => m.series_id as string);
  const built = resolve(import.meta.dirname, "../../../../tools/trainforge/dist/manifest.json");
  const fromManifest = existsSync(built)
    ? (JSON.parse(readFileSync(built, "utf8")).models as { seriesId?: string | null }[])
        .map((m) => m.seriesId)
        .filter((id): id is string => typeof id === "string")
    : [];
  return new Set(fromManifest.length > 0 ? fromManifest : fromYaml);
};

describe("the generated table", () => {
  it("names only related series the forge builds a model for", () => {
    expect(missingRelatedModels(IDENTICAL_BODY_TABLE, forgeSeries())).toEqual([]);
  });

  it("matches catalog/identical-bodies.yaml and catalog/vehicle-series.yaml", () => {
    const rows = catalogue("identical-bodies.yaml") as BodyRow[];
    const series = catalogue("vehicle-series.yaml") as SeriesRow[];
    expect(IDENTICAL_BODY_TABLE).toEqual(bodyTable(rows, series));
  });
});
