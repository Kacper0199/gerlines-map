import { describe, expect, it } from "vitest";
import { PlacesFileError, parsePlaces } from "./places.ts";

const HEADER =
  "id\ttype\tname_en\tname_de\tname_pl\tregion_en\tregion_de\tregion_pl\tland_code\tlon\tlat\twest\tsouth\teast\tnorth\trank";

describe("parsePlaces", () => {
  it("reads a name with a quotation mark as written, since the file is never quoted", () => {
    const [place] = parsePlaces(
      `${HEADER}\ntown:1\ttown\tA "B"\tA "B"\tA "B"\t\t\t\t\t7\t50\t\t\t\t\t0\n`,
    );
    expect(place?.names.de).toBe('A "B"');
  });

  it("reads a Land with its box and a town with its Land as region", () => {
    const places = parsePlaces(
      [
        HEADER,
        "land:DE-BY\tland\tBavaria\tBayern\tBawaria\t\t\t\tDE-BY\t11.8\t48.7\t8.97\t47.27\t13.84\t50.56\t3",
        "town:05315000\ttown\tCologne\tKöln\tKolonia\tNorth Rhine-Westphalia\tNordrhein-Westfalen\tNadrenia Północna-Westfalia\t\t6.95707\t50.93811\t\t\t\t\t2",
        "",
      ].join("\n"),
    );
    expect(places).toEqual([
      {
        id: "land:DE-BY",
        type: "land",
        names: { en: "Bavaria", de: "Bayern", pl: "Bawaria" },
        region: null,
        landCode: "DE-BY",
        lon: 11.8,
        lat: 48.7,
        bbox: [8.97, 47.27, 13.84, 50.56],
        rank: 3,
      },
      expect.objectContaining({
        id: "town:05315000",
        names: { en: "Cologne", de: "Köln", pl: "Kolonia" },
        region: expect.objectContaining({ de: "Nordrhein-Westfalen" }),
        bbox: null,
        rank: 2,
      }),
    ]);
  });

  it("refuses a file with another header, a short row or a bad number", () => {
    expect(() => parsePlaces("id\tname\n")).toThrow(PlacesFileError);
    expect(() => parsePlaces(`${HEADER}\ntown:1\ttown\tA`)).toThrow(/line 2/);
    expect(() => parsePlaces(`${HEADER}\ntown:1\ttown\tA\tA\tA\t\t\t\t\tx\t1\t\t\t\t\t0`)).toThrow(
      /not a number/,
    );
  });
});
