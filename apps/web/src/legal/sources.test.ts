import { readFileSync } from "node:fs";
import { legalCopyFor } from "@gerlines/i18n/legal";
import { describe, expect, it } from "vitest";
import { ELEVATION_ROWS, IMAGERY_ROWS } from "./providers.ts";
import { GROUP_ORDER, SOURCES } from "./sources.ts";

const DATA_SOURCES = readFileSync(
  new URL("../../../../docs/data-sources.md", import.meta.url),
  "utf8",
);

const LAENDER = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
];

function cells(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** The source named by each table row of docs/data-sources.md: the Source column, else the first one. */
function documentedSources(markdown: string): string[] {
  const names: string[] = [];
  let column = -1;
  let header = true;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      header = true;
      continue;
    }
    const row = cells(line);
    if (header) {
      column = Math.max(0, row.indexOf("Source"));
      header = false;
      continue;
    }
    if (row.every((cell) => /^-+$/.test(cell))) continue;
    const name = row[column];
    if (name) names.push(name);
  }
  return names;
}

function names(name: string, candidate: string): boolean {
  return (
    name === candidate ||
    (name.startsWith(candidate) && /^[\s,;(]/.test(name.slice(candidate.length)))
  );
}

describe("sources and licences list", () => {
  const documented = documentedSources(DATA_SOURCES);

  it("reads every table row of docs/data-sources.md", () => {
    expect(documented.length).toBeGreaterThanOrEqual(40);
    expect(documented).toContain("DELFI national GTFS");
    expect(documented).toContain("static timetables only");
  });

  it("lists every source of docs/data-sources.md", () => {
    const listed = SOURCES.flatMap((entry) => entry.docNames);
    const missing = documented.filter(
      (name) => !listed.some((candidate) => names(name, candidate)),
    );
    expect(missing).toEqual([]);
  });

  it("names only rows that exist in docs/data-sources.md", () => {
    const stale = SOURCES.flatMap((entry) => entry.docNames).filter(
      (candidate) => !documented.some((name) => name.includes(candidate)),
    );
    expect(stale).toEqual([]);
  });

  it("has a use text in every language for every source and a heading for every group", () => {
    for (const locale of ["en", "de", "pl"] as const) {
      const legal = legalCopyFor(locale).legal;
      for (const entry of SOURCES) {
        expect(legal.uses, entry.id).toHaveProperty(entry.id);
      }
      for (const group of GROUP_ORDER) {
        expect(legal.groups[group].length).toBeGreaterThan(0);
      }
    }
    expect(new Set(SOURCES.map((entry) => entry.id)).size).toBe(SOURCES.length);
    expect(SOURCES.every((entry) => GROUP_ORDER.includes(entry.group))).toBe(true);
  });

  it("links only over https", () => {
    const urls = [
      ...SOURCES.flatMap((entry) => [entry.url, ...entry.licences.map((licence) => licence.url)]),
      ...[...IMAGERY_ROWS, ...ELEVATION_ROWS].flatMap((row) => [row.url, row.licenceUrl]),
    ].filter((url): url is string => url !== null);
    expect(urls.filter((url) => !url.startsWith("https://"))).toEqual([]);
  });

  it("credits the orthophotos of all 16 Länder and the Sentinel-2 mosaic", () => {
    const coverage = IMAGERY_ROWS.map((row) => row.coverage);
    expect(LAENDER.filter((land) => !coverage.includes(land))).toEqual([]);
    expect(IMAGERY_ROWS.some((row) => row.provider.startsWith("Sentinel-2"))).toBe(true);
    expect(IMAGERY_ROWS.every((row) => row.provider.length > 0 && row.licence.length > 0)).toBe(
      true,
    );
  });

  it("credits every German Mapterhorn elevation source and the global fill", () => {
    const german = ELEVATION_ROWS.filter((row) => row.coverage === "Deutschland");
    expect(german.length).toBeGreaterThanOrEqual(16);
    expect(german.some((row) => row.provider.includes("Bayerische Vermessungsverwaltung"))).toBe(
      true,
    );
    expect(ELEVATION_ROWS.some((row) => row.dataset === "COPERNICUS GLO-30")).toBe(true);
    expect(ELEVATION_ROWS.every((row) => row.licence.length > 0)).toBe(true);
  });

  it("keeps BKG and Natural Earth with their licences", () => {
    const bkg = SOURCES.find((entry) => entry.id === "bkgVg250");
    expect(bkg?.licences.map((licence) => licence.name)).toEqual(["DL-DE BY 2.0"]);
    expect(bkg?.attribution).toEqual({ note: "changed", holder: "© GeoBasis-DE / BKG (2026)" });
    const ne = SOURCES.find((entry) => entry.id === "naturalEarth");
    expect(ne?.licences.map((licence) => licence.name)).toEqual(["Public domain"]);
  });

  it("lists DB StaDa for station names with its credit", () => {
    const stada = SOURCES.find((entry) => entry.id === "dbStada");
    expect(stada?.licences.map((licence) => licence.name)).toEqual(["CC BY 4.0"]);
    expect(stada?.attribution).toBe("Deutsche Bahn AG");
    expect(stada?.url).toBe(
      "https://developers.deutschebahn.com/db-api-marketplace/apis/product/stada",
    );
    for (const locale of ["en", "de", "pl"] as const) {
      expect(legalCopyFor(locale).legal.uses.dbStada).toMatch(/FaSta/);
    }
    expect(legalCopyFor("en").legal.uses.dbStada).toMatch(/^Station names/);
  });
});
