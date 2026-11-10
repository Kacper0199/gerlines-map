import { describe, expect, it } from "vitest";
import { creditParts, licenceName } from "./licence-names.ts";
import { ELEVATION_ROWS, IMAGERY_ROWS } from "./providers.ts";
import { SOURCES } from "./sources.ts";

describe("licenceName", () => {
  it.each([
    ["DL-DE->BY-2.0", "DL-DE BY 2.0"],
    ["Datenlizenz Deutschland - Namensnennung - Version 2.0", "DL-DE BY 2.0"],
    ["Datenlizenz Deutschland – Namensnennung – Version 2.0", "DL-DE BY 2.0"],
    ["DL-DE/ZERO-2.0", "DL-DE ZERO 2.0"],
    ["DL-DE->Zero-2.0", "DL-DE ZERO 2.0"],
    ["Datenlizenz Deutschland - Zero - Version 2.0", "DL-DE ZERO 2.0"],
    ["CC-BY 4.0", "CC BY 4.0"],
    ["CC-BY-4.0", "CC BY 4.0"],
    ["CC-BY-4.0: Land Kärnten - data.gv.at", "CC BY 4.0"],
    ["Creative Commons Namensnennung 4.0 International (CC BY 4.0)", "CC BY 4.0"],
    ["CC0", "CC0 1.0"],
  ])("writes %s as %s", (raw, shown) => {
    expect(licenceName(raw)).toBe(shown);
  });

  it("keeps a name it does not know and the page's own names", () => {
    for (const name of ["CC BY-SA 4.0", "CC BY 4.0", "CC0 1.0", "DL-DE BY 2.0", "Public Domain"]) {
      expect(licenceName(name)).toBe(name);
    }
    expect(licenceName("Model license for free reuse")).toBe("Model license for free reuse");
    expect(licenceName("Licence Ouverte / Open Licence version 2.0")).toBe(
      "Licence Ouverte / Open Licence version 2.0",
    );
  });

  it("leaves no raw licence id of the German open-data licences or Creative Commons in any provider row", () => {
    const shown = [...IMAGERY_ROWS, ...ELEVATION_ROWS].map((row) => licenceName(row.licence));
    expect(
      shown.filter((name) => /DL-DE[^ ]|Datenlizenz|CC-BY|Creative Commons/.test(name)),
    ).toEqual([]);
    expect(new Set(shown.filter((name) => /^(DL-DE|CC)/.test(name)))).toEqual(
      new Set(["CC BY 4.0", "CC0 1.0", "DL-DE BY 2.0", "DL-DE ZERO 2.0"]),
    );
  });

  it("agrees with the names of the source list for the licences both use", () => {
    const own = new Set(SOURCES.flatMap((entry) => entry.licences.map((licence) => licence.name)));
    for (const name of ["CC BY 4.0", "CC0 1.0", "DL-DE BY 2.0"]) expect(own.has(name)).toBe(true);
  });
});

describe("creditParts", () => {
  it("keeps the hyphen with the word after it", () => {
    expect(creditParts("Bayerische Vermessungsverwaltung - www.geodaten.bayern.de")).toEqual({
      head: "Bayerische Vermessungsverwaltung",
      joint: "- www.geodaten.bayern.de",
      rest: "",
    });
    expect(creditParts("BEV - Bundesamt für Eich- und Vermessungswesen")).toEqual({
      head: "BEV",
      joint: "- Bundesamt",
      rest: " für Eich- und Vermessungswesen",
    });
  });

  it("returns null for a credit without a spaced hyphen", () => {
    expect(creditParts("Sentinel-2 Global Mosaic")).toBeNull();
    expect(creditParts("Eich- und Vermessungswesen")).toBeNull();
  });
});
