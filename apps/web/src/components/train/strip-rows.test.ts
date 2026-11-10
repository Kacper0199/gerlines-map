import { describe, expect, it } from "vitest";
import { buildCardModel } from "./model.ts";
import { type StripRow, stripRows } from "./strip-rows.ts";
import { FIVE_STOPS, MINUTE, T0, testDetail, testStops } from "./test-detail.ts";

const NOW = T0 + 30 * MINUTE;

function shape(rows: StripRow[]): string[] {
  return rows.map((row) => {
    const name = row.kind === "now" ? "now" : `${row.kind}:${row.stop.name}`;
    return `${name} ${row.upper}/${row.lower}`;
  });
}

describe("stripRows", () => {
  it("shows the last passed stop, Now and the next stop when collapsed", () => {
    const rows = stripRows(buildCardModel(testDetail(), NOW), "focus", false);
    expect(shape(rows)).toEqual([
      "passed:Berlin-Spandau none/passed",
      "now passed/ahead",
      "headline:Stendal Hbf ahead/none",
    ]);
  });

  it("starts the line at the Now dot in the phone peek", () => {
    const rows = stripRows(buildCardModel(testDetail(), NOW), "focus", true);
    expect(shape(rows)).toEqual(["now none/ahead", "headline:Stendal Hbf ahead/none"]);
  });

  it("lists every stop with passed and ahead parts of the line", () => {
    const rows = stripRows(buildCardModel(testDetail(), NOW), "all", false);
    expect(shape(rows)).toEqual([
      "passed:Berlin Hbf none/passed",
      "passed:Berlin-Spandau passed/passed",
      "now passed/ahead",
      "headline:Stendal Hbf ahead/ahead",
      "upcoming:Wolfsburg Hbf ahead/ahead",
      "upcoming:Hannover Hbf ahead/none",
    ]);
  });

  it("keeps a skipped cancelled stop ahead of Now", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i === 2 ? { ...spec, cancelled: true } : spec));
    const rows = stripRows(
      buildCardModel(testDetail({ stops: testStops(specs) }), NOW),
      "all",
      false,
    );
    expect(shape(rows).slice(1, 5)).toEqual([
      "passed:Berlin-Spandau passed/passed",
      "now passed/ahead",
      "upcoming:Stendal Hbf ahead/ahead",
      "headline:Wolfsburg Hbf ahead/ahead",
    ]);
  });

  it("shows the first stop and the next one before departure", () => {
    const detail = testDetail({ progress: { lastPassedIndex: null, nextIndex: 0 } });
    const rows = stripRows(buildCardModel(detail, T0 - 5 * MINUTE), "focus", false);
    expect(shape(rows)).toEqual([
      "headline:Berlin Hbf none/ahead",
      "upcoming:Berlin-Spandau ahead/none",
    ]);
  });

  it("keeps only the stop the train stands at in the phone peek", () => {
    const detail = testDetail({ progress: { lastPassedIndex: 2, nextIndex: 3 } });
    const rows = stripRows(buildCardModel(detail, T0 + 47 * MINUTE), "focus", true);
    expect(shape(rows)).toEqual(["headline:Stendal Hbf none/none"]);
  });

  it("ends with the destination once the train has arrived", () => {
    const detail = testDetail({ progress: { lastPassedIndex: 4, nextIndex: null } });
    const rows = stripRows(buildCardModel(detail, T0 + 110 * MINUTE), "focus", false);
    expect(shape(rows)).toEqual([
      "passed:Wolfsburg Hbf none/passed",
      "headline:Hannover Hbf passed/none",
    ]);
  });

  it("shows cancelled stops between Now and the next served stop when collapsed", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i === 2 ? { ...spec, cancelled: true } : spec));
    const model = buildCardModel(testDetail({ stops: testStops(specs) }), NOW);
    expect(shape(stripRows(model, "focus", false))).toEqual([
      "passed:Berlin-Spandau none/passed",
      "now passed/ahead",
      "upcoming:Stendal Hbf ahead/ahead",
      "headline:Wolfsburg Hbf ahead/none",
    ]);
    expect(shape(stripRows(model, "focus", true))).toEqual([
      "now none/ahead",
      "upcoming:Stendal Hbf ahead/ahead",
      "headline:Wolfsburg Hbf ahead/none",
    ]);
  });

  it("draws the line after the last served stop of a train that ends early in passed grey", () => {
    const specs = FIVE_STOPS.map((spec, i) => (i >= 3 ? { ...spec, cancelled: true } : spec));
    const model = buildCardModel(testDetail({ stops: testStops(specs) }), NOW);
    expect(shape(stripRows(model, "all", false)).slice(3)).toEqual([
      "headline:Stendal Hbf ahead/passed",
      "upcoming:Wolfsburg Hbf passed/passed",
      "upcoming:Hannover Hbf passed/none",
    ]);
  });

  it("draws a cancelled train in plain rows from first to last stop", () => {
    const rows = stripRows(buildCardModel(testDetail({ cancelled: true }), NOW), "focus", false);
    expect(shape(rows)).toEqual(["plain:Berlin Hbf none/plain", "plain:Hannover Hbf plain/none"]);
  });
});
