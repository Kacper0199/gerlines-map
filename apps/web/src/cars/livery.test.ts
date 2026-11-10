import { describe, expect, it } from "vitest";
import { dayOf, NEUTRAL_ROW, parseLiveryBook } from "./livery.ts";

const book = parseLiveryBook({
  groups: {
    db: ["db-regio-ag", "db-regio-ag-nrw", "db-regio-ag-bayern", "db-fernverkehr-ag"],
    "hlb-bahn": ["hlb-bahn", "hlb-sued"],
  },
  rules: [
    {
      livery: "db-red-422",
      row: 3,
      operator: "db-regio-ag",
      group: "db",
      series: ["db-422", "db-648"],
    },
    {
      livery: "vrr-422",
      row: 4,
      operator: "db-regio-ag-nrw",
      series: ["db-422"],
      lines: ["S1", "S4"],
    },
    {
      livery: "hlb-648",
      row: 5,
      operator: "hlb-bahn",
      group: "hlb-bahn",
      series: ["db-648"],
      validFrom: "2020-01-01",
      validTo: "2030-12-31",
    },
    {
      livery: "nrw-648",
      row: 6,
      operator: "db-regio-ag-nrw",
      series: ["db-648"],
    },
  ],
});

const trip = (series: string | null, operator: string | null, line: string | null = null) => ({
  series,
  operator,
  line,
});

describe("LiveryBook.rowFor", () => {
  it("takes the row of the livery for the operator and series", () => {
    expect(book.rowFor(trip("db-648", "hlb-bahn"), "2026-11-08")).toBe(5);
  });

  it("lets the companies of a group share the livery of the operator above them", () => {
    expect(book.rowFor(trip("db-648", "hlb-sued"), "2026-11-08")).toBe(5);
    expect(book.rowFor(trip("db-422", "db-regio-ag-bayern"), "2026-11-08")).toBe(3);
    expect(book.rowFor(trip("db-422", "db-fernverkehr-ag"), "2026-11-08")).toBe(3);
  });

  it("prefers the operator's own livery over the group's", () => {
    expect(book.rowFor(trip("db-648", "db-regio-ag-nrw"), "2026-11-08")).toBe(6);
    expect(book.rowFor(trip("db-648", "db-regio-ag"), "2026-11-08")).toBe(3);
  });

  it("splits one operator's series by line, the line rule first, the plain rule for the other lines", () => {
    expect(book.rowFor(trip("db-422", "db-regio-ag-nrw", "S1"), "2026-11-08")).toBe(4);
    expect(book.rowFor(trip("db-422", "db-regio-ag-nrw", "S4"), "2026-11-08")).toBe(4);
    expect(book.rowFor(trip("db-422", "db-regio-ag-nrw", "S6"), "2026-11-08")).toBe(3);
    expect(book.rowFor(trip("db-422", "db-regio-ag-nrw", null), "2026-11-08")).toBe(3);
  });

  it("applies a rule only on its days", () => {
    expect(book.rowFor(trip("db-648", "hlb-bahn"), "2019-12-31")).toBe(NEUTRAL_ROW);
    expect(book.rowFor(trip("db-648", "hlb-bahn"), "2020-01-01")).toBe(5);
    expect(book.rowFor(trip("db-648", "hlb-bahn"), "2030-12-31")).toBe(5);
    expect(book.rowFor(trip("db-648", "hlb-bahn"), "2031-01-01")).toBe(NEUTRAL_ROW);
  });

  it("falls back to the neutral row for an operator no rule of the series names, or none at all", () => {
    expect(book.rowFor(trip("db-648", "some-bahn"), "2026-11-08")).toBe(NEUTRAL_ROW);
    expect(book.rowFor(trip("db-648", null), "2026-11-08")).toBe(NEUTRAL_ROW);
  });

  it("leaves a series without any rule to its model's own row", () => {
    expect(book.rowFor(trip("db-481", "s-bahn-berlin-gmbh"), "2026-11-08")).toBeUndefined();
    expect(book.rowFor(trip(null, "db-regio-ag"), "2026-11-08")).toBeUndefined();
  });

  it("is empty for a manifest without livery rules", () => {
    expect(
      parseLiveryBook(undefined).rowFor(trip("db-648", "hlb-bahn"), "2026-11-08"),
    ).toBeUndefined();
  });
});

describe("a Land livery and a line rule stay with their own operator", () => {
  const regional = parseLiveryBook({
    groups: {
      db: [
        "db-regio-ag",
        "db-regio-ag-baden-wuerttemberg",
        "db-regio-ag-nordost",
        "db-regio-ag-nrw",
      ],
    },
    rules: [
      {
        livery: "db-regio-verkehrsrot",
        row: 1,
        operator: "db-regio-ag",
        group: "db",
        series: ["db-463"],
      },
      {
        livery: "bwegt-463",
        row: 2,
        operator: "db-regio-ag-baden-wuerttemberg",
        series: ["db-463"],
      },
      {
        livery: "vrr-422",
        row: 3,
        operator: "db-regio-ag-nrw",
        series: ["db-422"],
        lines: ["S1", "S4"],
      },
      {
        livery: "root-line",
        row: 4,
        operator: "db-regio-ag",
        group: "db",
        series: ["db-422"],
        lines: ["S1"],
      },
      { livery: "root-422", row: 5, operator: "db-regio-ag", group: "db", series: ["db-422"] },
    ],
  });

  it("paints a db-463 of another DB network in the DB Regio red, not in the Baden-Wuerttemberg design", () => {
    expect(regional.rowFor(trip("db-463", "db-regio-ag-nordost"), "2026-11-08")).toBe(1);
    expect(regional.rowFor(trip("db-463", "db-regio-ag-nrw"), "2026-11-08")).toBe(1);
    expect(regional.rowFor(trip("db-463", "db-regio-ag-baden-wuerttemberg"), "2026-11-08")).toBe(2);
  });

  it("never lets the line rule of a group's livery reach the companies of the group", () => {
    expect(regional.rowFor(trip("db-422", "db-regio-ag-nordost", "S1"), "2026-11-08")).toBe(5);
    expect(regional.rowFor(trip("db-422", "db-regio-ag", "S1"), "2026-11-08")).toBe(4);
    expect(regional.rowFor(trip("db-422", "db-regio-ag", "S2"), "2026-11-08")).toBe(5);
  });

  it("keeps a line rule of the own operator before the group's plain rule", () => {
    expect(regional.rowFor(trip("db-422", "db-regio-ag-nrw", "S4"), "2026-11-08")).toBe(3);
    expect(regional.rowFor(trip("db-422", "db-regio-ag-nrw", "S6"), "2026-11-08")).toBe(5);
  });
});

describe("dayOf", () => {
  it("reads the Europe/Berlin day of Unix seconds, winter and summer time", () => {
    expect(dayOf(Date.UTC(2026, 10, 8, 22, 59, 59) / 1000)).toBe("2026-11-08");
    expect(dayOf(Date.UTC(2026, 10, 8, 23, 0, 0) / 1000)).toBe("2026-11-09");
    expect(dayOf(Date.UTC(2026, 5, 30, 21, 59, 59) / 1000)).toBe("2026-06-30");
    expect(dayOf(Date.UTC(2026, 5, 30, 22, 0, 0) / 1000)).toBe("2026-07-01");
  });

  it("answers the same day twice in a row and the next one after a day boundary", () => {
    const night = Date.UTC(2026, 11, 31, 23, 30, 0) / 1000;
    expect(dayOf(night)).toBe("2027-01-01");
    expect(dayOf(night + 10)).toBe("2027-01-01");
    expect(dayOf(night - 3_600)).toBe("2026-12-31");
  });

  it("starts a livery on the Berlin day it is valid from", () => {
    const dated = parseLiveryBook({
      groups: {},
      rules: [{ livery: "new", row: 7, operator: "x", series: ["s"], validFrom: "2026-12-14" }],
    });
    const lateEvening = Date.UTC(2026, 11, 13, 23, 30, 0) / 1000;
    expect(dated.rowFor(trip("s", "x"), dayOf(lateEvening))).toBe(7);
    expect(dated.rowFor(trip("s", "x"), dayOf(lateEvening - 3_600 * 2))).toBe(NEUTRAL_ROW);
  });
});

describe.skipIf(Boolean(process.env.CI))("the frame cost of picking liveries", () => {
  it("resolves 3,000 trains uncached in a fraction of a frame (budget 10 times the measured 2 ms)", () => {
    const trips = Array.from({ length: 3_000 }, (_, i) =>
      trip(
        i % 2 ? "db-422" : "db-648",
        i % 3 ? "db-regio-ag-nrw" : "hlb-sued",
        i % 5 ? "S6" : "S1",
      ),
    );
    let sink = 0;
    const started = performance.now();
    for (const t of trips) sink += book.rowFor(t, "2026-11-08") ?? -1;
    const elapsed = performance.now() - started;
    expect(sink).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
