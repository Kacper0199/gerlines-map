import { describe, expect, it } from "vitest";
import { vehicleCopyFor } from "./copy-vehicle.ts";

describe("vehicle copy", () => {
  it("counts units with the plural forms of each language", () => {
    const en = vehicleCopyFor("en").units;
    expect([1, 2].map(en)).toEqual(["1 unit", "2 units"]);
    const de = vehicleCopyFor("de").units;
    expect([1, 2].map(de)).toEqual(["1 Einheit", "2 Einheiten"]);
    const pl = vehicleCopyFor("pl").units;
    expect([1, 2, 4, 5, 12, 22, 25].map(pl)).toEqual([
      "1 jednostka",
      "2 jednostki",
      "4 jednostki",
      "5 jednostek",
      "12 jednostek",
      "22 jednostki",
      "25 jednostek",
    ]);
  });

  it("names a series by its Baureihe number, in the plural for several numbers", () => {
    expect(vehicleCopyFor("en").seriesBr("422", 1)).toBe("DB Class 422");
    expect(vehicleCopyFor("de").seriesBr("422", 1)).toBe("Baureihe 422");
    expect(vehicleCopyFor("de").seriesBr("483 und 484", 2)).toBe("Baureihen 483 und 484");
  });

  it("starts the Polish series with a capital and names DB so it is not read as a PKP series", () => {
    expect(vehicleCopyFor("pl").seriesBr("422", 1)).toBe("Seria DB 422");
    expect(vehicleCopyFor("pl").seriesBr("483 i 484", 2)).toBe("Serie DB 483 i 484");
  });
});
