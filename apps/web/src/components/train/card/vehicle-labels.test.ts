import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vehicleCopyFor } from "@gerlines/i18n/vehicle";
import { VEHICLE_SEQUENCE_SOURCE } from "@gerlines/schema";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { seriesDisplayName, sourceDisplayName, vehicleFactParts } from "./vehicle-labels.ts";

const SERIES = load(
  readFileSync(
    resolve(import.meta.dirname, "../../../../../../catalog/vehicle-series.yaml"),
    "utf8",
  ),
) as { series_id: string; name: string; br?: string }[];

describe("seriesDisplayName of a generic model", () => {
  const generic = {
    seriesId: "generic-sbahn",
    seriesName: "Generic S-Bahn multiple unit",
    br: null,
  };

  it("keeps the catalogue name in English and translates it in German and Polish", () => {
    expect(seriesDisplayName(generic, "en")).toBe("Generic S-Bahn multiple unit");
    expect(seriesDisplayName(generic, "de")).toBe("Typischer S-Bahn-Triebzug");
    expect(seriesDisplayName(generic, "pl")).toBe("Typowy zespół trakcyjny S-Bahn");
  });

  it("translates every generic model of the catalogue and keeps the name of a series", () => {
    const models = load(
      readFileSync(resolve(import.meta.dirname, "../../../../../../catalog/vehicles.yaml"), "utf8"),
    ) as { model_id: string; name: string; generic?: boolean }[];
    const genericModels = models.filter((model) => model.generic === true);
    expect(genericModels.length).toBeGreaterThan(0);
    for (const model of genericModels) {
      const input = { seriesId: model.model_id, seriesName: model.name, br: null };
      expect(seriesDisplayName(input, "de")).not.toBe(model.name);
      expect(seriesDisplayName(input, "pl")).not.toBe(model.name);
    }
    const series = { seriesId: "db-481", seriesName: "DB Class 481", br: "481" };
    expect(seriesDisplayName(series, "de")).toBe("Baureihe 481");
  });
});

describe("seriesDisplayName", () => {
  const named = (seriesName: string, br?: string | null) =>
    br === undefined ? { seriesId: "x", seriesName } : { seriesId: "x", seriesName, br };

  it("keeps the catalogue name in English", () => {
    expect(seriesDisplayName(named("DB Class 422", "422"), "en")).toBe("DB Class 422");
  });

  it("names a DB Class series by the Baureihe number the API carries", () => {
    expect(seriesDisplayName(named("DB Class 422", "422"), "de")).toBe("Baureihe 422");
    expect(seriesDisplayName(named("DB Class 422", "422"), "pl")).toBe("Seria DB 422");
    expect(seriesDisplayName(named("DB Class 146.5", "146.5"), "de")).toBe("Baureihe 146.5");
  });

  it("takes the number from br and not from the name when they differ", () => {
    expect(seriesDisplayName(named("DB Class 425.1", "425"), "de")).toBe("Baureihe 425");
  });

  it("names several numbers in the plural with each language's conjunction", () => {
    const pair = named("DB Class 483 and 484", "483, 484");
    expect(seriesDisplayName(pair, "de")).toBe("Baureihen 483 und 484");
    expect(seriesDisplayName(pair, "pl")).toBe("Serie DB 483 i 484");
    expect(seriesDisplayName(named("DB Class 1 and 2 and 3", "1, 2, 3"), "de")).toBe(
      "Baureihen 1, 2 und 3",
    );
  });

  it("leaves product names alone even where the catalogue has a br", () => {
    for (const [name, br] of [
      ["ICE 3", "403"],
      ["Siemens Vectron", "193"],
      ["Talent 2", "442"],
      ["GT8-100D/2S-M", null],
    ] as const) {
      expect(seriesDisplayName(named(name, br), "de")).toBe(name);
      expect(seriesDisplayName(named(name, br), "pl")).toBe(name);
    }
  });

  it("falls back to the number in the name for an older answer without br", () => {
    expect(seriesDisplayName(named("DB Class 422"), "de")).toBe("Baureihe 422");
    expect(seriesDisplayName(named("DB Class 483 and 484"), "pl")).toBe("Serie DB 483 i 484");
  });

  it("does not invent a number where the catalogue has none", () => {
    expect(seriesDisplayName(named("DB Class 422", null), "de")).toBe("DB Class 422");
  });

  it("agrees with vehicle_series.br for every series called DB Class", () => {
    const classes = SERIES.filter((row) => row.name.startsWith("DB Class "));
    expect(classes.length).toBeGreaterThan(30);
    for (const row of classes) {
      const expected = String(row.br).replace(", ", " und ");
      const label = seriesDisplayName(
        { seriesId: row.series_id, seriesName: row.name, br: String(row.br) },
        "de",
      );
      expect(label, row.series_id).toBe(
        `${String(row.br).includes(",") ? "Baureihen" : "Baureihe"} ${expected}`,
      );
      expect(
        seriesDisplayName({ seriesId: row.series_id, seriesName: row.name }, "de"),
        row.series_id,
      ).toBe(label);
    }
  });
});

describe("sourceDisplayName", () => {
  const copy = vehicleCopyFor("de");

  it("shows the display name the API sends, never the id", () => {
    expect(
      sourceDisplayName(
        {
          source: "wikipedia-de-s-bahn-rhein-ruhr",
          sourceName: "Wikipedia (de), S-Bahn Rhein-Ruhr",
        },
        copy,
      ),
    ).toBe("Wikipedia (de), S-Bahn Rhein-Ruhr");
  });

  it("shows a source the web has never seen by the name the API sends", () => {
    expect(
      sourceDisplayName(
        { source: "wikipedia-de-new-list", sourceName: "Wikipedia (de), Neu" },
        copy,
      ),
    ).toBe("Wikipedia (de), Neu");
  });

  it("names the two sources the page translates in the language of the page", () => {
    const sequence = { source: VEHICLE_SEQUENCE_SOURCE, sourceName: "bahn.de vehicle sequence" };
    expect(
      sourceDisplayName({ source: "gerlines", sourceName: "GerLines catalogue curation" }, copy),
    ).toBe("GerLines Katalog");
    expect(sourceDisplayName(sequence, copy)).toBe("bahn.de Wagenreihung");
  });

  it("leaves out a source the API sends without a name, or an answer older than the name", () => {
    expect(sourceDisplayName({ source: "something-new", sourceName: null }, copy)).toBeNull();
    expect(sourceDisplayName({ source: "wikipedia-de-s-bahn-rhein-ruhr" }, copy)).toBeNull();
  });
});

describe("vehicleFactParts", () => {
  const vehicle = { units: 2, cars: null, lengthMetres: 138.86 };

  it("gives the units, then the cars, then the length", () => {
    expect(vehicleFactParts({ units: 2, cars: 7, lengthMetres: 138.86 }, "en")).toEqual([
      "2 units",
      "7 cars",
      "139 m",
    ]);
  });

  it("counts units in each language", () => {
    expect(vehicleFactParts(vehicle, "en")).toEqual(["2 units", "139 m"]);
    expect(vehicleFactParts(vehicle, "de")).toEqual(["2 Einheiten", "139 m"]);
    expect(vehicleFactParts(vehicle, "pl")).toEqual(["2 jednostki", "139 m"]);
    expect(vehicleFactParts({ ...vehicle, units: 5 }, "pl")[0]).toBe("5 jednostek");
  });

  it("leaves out what the data does not have", () => {
    expect(vehicleFactParts({ units: null, cars: null, lengthMetres: null }, "en")).toEqual([]);
    expect(vehicleFactParts({ units: 1, cars: null, lengthMetres: null }, "en")).toEqual([
      "1 unit",
    ]);
  });
});
