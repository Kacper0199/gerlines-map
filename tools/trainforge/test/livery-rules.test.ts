import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLiveryBook } from "../../../apps/web/src/cars/livery.ts";
import { buildAll, manifestJson } from "../src/build.ts";
import { type CatalogInput, readCatalog, type VehicleInput } from "../src/catalog.ts";
import { liveryRules, liveryTies, operatorGroups } from "../src/livery-rules.ts";
import { dbOperators } from "../src/logo.ts";

const vehicle = (model_id: string, series_id: string | null, livery_id: string | null) =>
  ({ model_id, series_id, livery_id }) as unknown as VehicleInput;

const catalog: CatalogInput = {
  vehicles: [
    vehicle("db-a", "db-a", "db-livery"),
    vehicle("db-a-long", "db-a", "db-livery"),
    vehicle("x-1", "x", "x-livery"),
    vehicle("neutral-1", "n", null),
  ],
  liveries: [
    {
      livery_id: "db-livery",
      name: "DB",
      operator_id: "db-regio-ag",
      colours: [],
      source: "s",
    },
    {
      livery_id: "x-livery",
      name: "X",
      operator_id: "x-bahn",
      series_ids: ["x", "y"],
      lines: ["S1"],
      valid_from: "2020-01-01" as unknown as string,
      valid_to: new Date("2030-12-31T00:00:00Z") as unknown as string,
      colours: [],
      source: "s",
    },
    { livery_id: "no-operator", name: "Y", colours: [], source: "s" },
  ],
  operators: [
    { operator_id: "db", wikidata_qid: "Q9322" },
    {
      operator_id: "db-regio-ag",
      wikidata_qid: "Q18853",
      parents: [{ name: "DB", wikidata_qid: "Q9322" }],
    },
    {
      operator_id: "db-regio-ag-nrw",
      wikidata_qid: "Q1152084",
      parents: [{ name: "DB Regio", wikidata_qid: "Q18853" }],
    },
    { operator_id: "x-bahn", wikidata_qid: "Q1" },
    {
      operator_id: "x-bahn-sued",
      wikidata_qid: "Q2",
      parents: [{ name: "X", wikidata_qid: "Q1" }],
    },
    { operator_id: "other", wikidata_qid: "Q3" },
  ],
};
const rows = ["neutral", "db-livery", "no-operator", "x-livery"].map((id) => ({ id }));

describe("operatorGroups", () => {
  it("names the DB group and the companies under another operator, never a lone operator", () => {
    const groups = operatorGroups(catalog);
    expect(groups.get("db-livery")).toBe("db");
    expect(groups.get("x-livery")).toBe("x-bahn");
    expect(groups.has("no-operator")).toBe(false);
  });
});

describe("operatorGroups of regional subsidiaries", () => {
  const livery = (livery_id: string, operator_id: string) => ({
    livery_id,
    name: livery_id,
    operator_id,
    colours: [],
    source: "s",
  });
  const grouped = operatorGroups({
    ...catalog,
    liveries: [
      livery("root", "db-regio-ag"),
      livery("land", "db-regio-ag-nrw"),
      livery("lone", "other"),
      livery("x", "x-bahn"),
    ],
  });

  it("opens the DB group only for a root company with companies under it", () => {
    expect(grouped.get("root")).toBe("db");
    expect(grouped.has("land")).toBe(false);
    expect(grouped.has("lone")).toBe(false);
    expect(grouped.get("x")).toBe("x-bahn");
  });
});

describe("liveryTies", () => {
  const rule = (livery: string, operator: string, extra: object = {}) => ({
    livery,
    row: 1,
    operator,
    series: ["s"],
    ...extra,
  });
  const groups = { db: ["db-a", "db-b", "db-c"] };

  it("finds two plain rules of one operator and two group rules that reach the same company", () => {
    expect(liveryTies([rule("p", "db-a"), rule("q", "db-a")], groups)).toHaveLength(1);
    expect(
      liveryTies([rule("p", "db-a", { group: "db" }), rule("q", "db-b", { group: "db" })], groups),
    ).toEqual(["p and q tie for db-c on series s"]);
  });

  it("accepts an own rule against a group rule, a line rule against a plain one, distinct lines and days", () => {
    expect(liveryTies([rule("p", "db-a", { group: "db" }), rule("q", "db-b")], groups)).toEqual([]);
    expect(liveryTies([rule("p", "db-a"), rule("q", "db-a", { lines: ["S1"] })], groups)).toEqual(
      [],
    );
    expect(
      liveryTies(
        [rule("p", "db-a", { lines: ["S1"] }), rule("q", "db-a", { lines: ["S2"] })],
        groups,
      ),
    ).toEqual([]);
    expect(
      liveryTies(
        [
          rule("p", "db-a", { validTo: "2025-12-31" }),
          rule("q", "db-a", { validFrom: "2026-01-01" }),
        ],
        groups,
      ),
    ).toEqual([]);
  });

  it("finds overlapping line sets but not disjoint ones, and ignores the lines of a group rule", () => {
    expect(
      liveryTies(
        [rule("p", "db-a", { lines: ["S1", "S4"] }), rule("q", "db-a", { lines: ["S1"] })],
        groups,
      ),
    ).toHaveLength(1);
    expect(
      liveryTies(
        [rule("p", "db-a", { group: "db", lines: ["S1"] }), rule("q", "db-b", { group: "db" })],
        groups,
      ),
    ).toEqual([]);
  });

  it("rejects an ambiguous catalogue when the rules are built", () => {
    const twin = {
      ...catalog.liveries[0],
      livery_id: "db-twin",
      series_ids: ["db-a"],
    } as (typeof catalog.liveries)[number];
    const ambiguous = { ...catalog, liveries: [...catalog.liveries, twin] };
    expect(() => liveryRules(ambiguous, [...rows, { id: "db-twin" }])).toThrow(
      /db-livery and db-twin tie/,
    );
  });
});

describe("liveryRules", () => {
  const { rules, groups } = liveryRules(catalog, rows);

  it("keys a livery by its operator and the series of its models and series_ids, in row order of id", () => {
    expect(rules.map((r) => r.livery)).toEqual(["db-livery", "x-livery"]);
    expect(rules[0]).toEqual({
      livery: "db-livery",
      row: 1,
      operator: "db-regio-ag",
      group: "db",
      series: ["db-a"],
    });
  });

  it("carries lines, the validity as ISO dates and the series of series_ids and models together", () => {
    expect(rules[1]).toEqual({
      livery: "x-livery",
      row: 3,
      operator: "x-bahn",
      group: "x-bahn",
      series: ["x", "y"],
      lines: ["S1"],
      validFrom: "2020-01-01",
      validTo: "2030-12-31",
    });
  });

  it("lists the members of each group once, sorted, and skips liveries without an operator", () => {
    expect(groups.db).toEqual(["db", "db-regio-ag", "db-regio-ag-nrw"]);
    expect(groups["x-bahn"]).toEqual(["x-bahn", "x-bahn-sued"]);
    expect(Object.keys(groups)).toEqual(["db", "x-bahn"]);
  });

  it("does not depend on the order of the input", () => {
    const shuffled = {
      ...catalog,
      liveries: [...catalog.liveries].reverse(),
      vehicles: [...catalog.vehicles].reverse(),
    };
    expect(liveryRules(shuffled, rows)).toEqual({ rules, groups });
  });
});

describe("a livery worn by trains of other operators", () => {
  const shared: CatalogInput = {
    ...catalog,
    vehicles: [...catalog.vehicles, vehicle("y-1", "y-series", "y-livery")],
    liveries: [
      ...catalog.liveries,
      {
        livery_id: "y-livery",
        name: "Y",
        operator_id: "lone-bahn",
        also_operator_ids: ["partner-bahn", "x-bahn"],
        colours: [],
        source: "s",
      },
    ],
    operators: [
      ...(catalog.operators ?? []),
      { operator_id: "lone-bahn", wikidata_qid: "Q10" },
      { operator_id: "partner-bahn", wikidata_qid: "Q11" },
    ],
  };
  const sharedRows = [{ id: "neutral" }, ...rows.slice(1), { id: "y-livery" }];

  it("opens a group of its own livery for the operator and the named others", () => {
    const { rules, groups } = liveryRules(shared, sharedRows);
    const y = rules.find((r) => r.livery === "y-livery");
    expect(y).toMatchObject({ operator: "lone-bahn", group: "y-livery", series: ["y-series"] });
    expect(groups["y-livery"]).toEqual(["lone-bahn", "partner-bahn", "x-bahn"]);
  });

  it("paints the series for each of them, their own rules first, and neutral for anyone else", () => {
    const { rules, groups } = liveryRules(shared, sharedRows);
    const book = parseLiveryBook({ groups, rules });
    const row = (operator: string) =>
      sharedRows[book.rowFor({ series: "y-series", operator }, "2026-11-08") ?? -1]?.id;
    expect(row("lone-bahn")).toBe("y-livery");
    expect(row("partner-bahn")).toBe("y-livery");
    expect(row("x-bahn")).toBe("y-livery");
    expect(row("other")).toBe("neutral");
  });

  it("refuses a livery that already opens a group of its company tree", () => {
    const both: CatalogInput = {
      ...shared,
      liveries: shared.liveries.map((l) =>
        l.livery_id === "x-livery" ? { ...l, also_operator_ids: ["partner-bahn"] } : l,
      ),
    };
    expect(() => liveryRules(both, sharedRows)).toThrow(/x-livery.*also_operator_ids/);
  });
});

describe("the committed catalogue", () => {
  const real = readCatalog(resolve(import.meta.dirname, "../../../catalog"));
  const realRows = [
    { id: "neutral" },
    ...real.liveries.map((l) => ({ id: l.livery_id })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  ];
  const { rules, groups } = liveryRules(real, realRows);
  const book = parseLiveryBook({ groups, rules });
  const rowId = (series: string, operator: string, line: string | null = null) =>
    realRows[book.rowFor({ series, operator, line }, "2026-11-08") ?? -1]?.id;

  it("keeps a Land livery with its own operator: no group on bwegt, the VRR designs or the S-Bahn liveries", () => {
    const groupOf = (id: string) => rules.find((r) => r.livery === id)?.group;
    expect(groupOf("bwegt-463-sampled")).toBeUndefined();
    expect(groupOf("vrr-flirt-3-xl-sampled")).toBeUndefined();
    expect(groupOf("vrr-s-bahn-422-sampled")).toBeUndefined();
    expect(groupOf("db-s-bahn-rhein-ruhr-422-red-sampled")).toBeUndefined();
    expect(groupOf("db-regio-verkehrsrot")).toBe("db");
    expect(groupOf("db-ice-verkehrsweiss")).toBe("db");
  });

  it("paints a db-463 of another DB network in the DB Regio red and only Baden-Wuerttemberg's in its design", () => {
    expect(rowId("db-463", "db-regio-ag-nordost")).toBe("db-regio-verkehrsrot");
    expect(rowId("db-463", "db-regio-ag-nrw")).toBe("db-regio-verkehrsrot");
    expect(rowId("db-463", "db-regio-ag")).toBe("db-regio-verkehrsrot");
    expect(rowId("db-463", "db-regio-ag-baden-wuerttemberg")).toBe("bwegt-463-sampled");
    expect(rowId("db-422", "db-regio-ag-nrw", "S1")).toBe("vrr-s-bahn-422-sampled");
    expect(rowId("db-422", "db-regio-ag-nrw", "S6")).toBe("db-s-bahn-rhein-ruhr-422-red-sampled");
    expect(rowId("db-422", "db-regio-ag-bayern", "S1")).not.toBe("vrr-s-bahn-422-sampled");
  });

  it("paints a TGV Duplex in the Carmillon livery for SNCF and for the DB Fernverkehr lines it runs on", () => {
    expect(rowId("sncf-tgv-duplex", "sncf")).toBe("sncf-tgv-carmillon-sampled");
    expect(rowId("sncf-tgv-duplex", "db-fernverkehr-ag")).toBe("sncf-tgv-carmillon-sampled");
    expect(rowId("sncf-tgv-duplex", "db-regio-ag")).toBe("neutral");
    expect(rowId("db-403", "db-fernverkehr-ag")).toBe("db-ice-verkehrsweiss");
  });

  it("has no tie for any company of a group: the rows do not depend on the order of the rules", () => {
    expect(liveryTies(rules, groups)).toEqual([]);
    const reversed = parseLiveryBook({ groups, rules: [...rules].reverse() });
    const operators = new Set([
      ...rules.map((r) => r.operator),
      ...Object.values(groups).flat(),
      "no-such-bahn",
    ]);
    const series = new Set(rules.flatMap((r) => r.series));
    const lines = [null, "S1", "S4", "S6", "RE10"];
    const days = ["2000-01-01", "2019-12-01", "2020-06-01", "2026-11-08", "2099-01-01"];
    const trips = [...series].flatMap((s) =>
      [...operators].flatMap((operator) => lines.map((line) => ({ series: s, operator, line }))),
    );
    for (const trip of trips)
      for (const day of days)
        expect(reversed.rowFor(trip, day), JSON.stringify([trip, day])).toBe(
          book.rowFor(trip, day),
        );
    expect(trips.length * days.length).toBeGreaterThan(5_000);
  });

  it("puts every rule on a palette row of its own livery and names an operator and a series", async () => {
    const built = await buildAll(real, ["db-422", "db-481"]);
    const { rules } = liveryRules(real, built.paletteRows);
    for (const rule of rules) {
      expect(built.paletteRows[rule.row]?.id).toBe(rule.livery);
      expect(rule.series.length).toBeGreaterThan(0);
    }
    expect(rules.some((r) => r.series.includes("db-481"))).toBe(true);
  });

  it("lists in the manifest the palette rows of DB operators as the rows with a logo", async () => {
    const built = await buildAll(real, ["db-481"]);
    const manifest = JSON.parse(manifestJson(built)) as { palette: { logoRows: number[] } };
    const db = dbOperators(real.operators ?? []);
    const owners = new Map(real.liveries.map((l) => [l.livery_id, l.operator_id ?? ""]));
    const expected = built.paletteRows.flatMap((row, index) =>
      db.has(owners.get(row.id) ?? "") ? [index] : [],
    );
    expect(manifest.palette.logoRows).toEqual(expected);
    expect(expected.length).toBeGreaterThan(5);
    expect(manifest.palette.logoRows).not.toContain(0);
  });
});
