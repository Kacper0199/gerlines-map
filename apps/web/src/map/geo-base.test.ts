import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GeoFiles, landLabelPoints, readLaender } from "./geo-base.ts";
import { LAND_CODES } from "./style/map-styles.ts";

const laender = JSON.parse(
  readFileSync(join(process.cwd(), "public/geo/laender.geojson"), "utf8"),
) as unknown;

describe("readLaender", () => {
  it("reads all 16 Länder of the geo base with names, label point and fit bounds", () => {
    const facts = readLaender(laender);

    expect(facts.map((land) => land.code).sort()).toEqual([...LAND_CODES].sort());
    const bayern = facts.find((land) => land.code === "DE-BY");
    expect(bayern?.names).toEqual({ en: "Bavaria", de: "Bayern", pl: "Bawaria" });
    expect(bayern?.label).toEqual([11.8178, 48.7403]);
    expect(bayern?.fit).toEqual([
      [8.9759, 47.2701],
      [13.8395, 50.5642],
    ]);
  });

  it("names Bremen by its short name in English", () => {
    const bremen = readLaender(laender).find((land) => land.code === "DE-HB");

    expect(bremen?.names).toEqual({ en: "Bremen", de: "Bremen", pl: "Brema" });
  });

  it("skips features without a known code, names or numbers", () => {
    const facts = readLaender({
      type: "FeatureCollection",
      features: [
        { properties: { code: "DE-XX", name_en: "X", name_de: "X", name_pl: "X" } },
        { properties: { code: "DE-BE", name_en: "Berlin", name_de: "Berlin", name_pl: "" } },
        { properties: null },
      ],
    });

    expect(facts).toEqual([]);
    expect(readLaender(null)).toEqual([]);
  });
});

describe("landLabelPoints", () => {
  it("places one point per Land at its label point with the three names", () => {
    const points = landLabelPoints(readLaender(laender));

    expect(points.features).toHaveLength(16);
    expect(points.features.find((f) => f.properties.code === "DE-BE")).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [13.3813, 52.5166] },
      properties: { code: "DE-BE", name_en: "Berlin", name_de: "Berlin", name_pl: "Berlin" },
    });
  });
});

describe("GeoFiles", () => {
  const collection = (name: string) => ({ type: "FeatureCollection", features: [], name });

  function served(fail: readonly string[] = []) {
    return vi.fn(async (url: string) => {
      const name = url.split("/geo/")[1] ?? "";
      if (fail.includes(name)) {
        throw new Error(`no ${name}`);
      }
      return collection(name);
    });
  }

  it("fetches the national files once, however often they are asked for", async () => {
    const fetchJson = served();
    const files = new GeoFiles("http://host/", fetchJson);

    const [first, second] = await Promise.all([files.national(), files.national()]);
    await files.national();

    expect(first).toBe(second);
    expect(fetchJson.mock.calls.map(([url]) => url).sort()).toEqual([
      "http://host/geo/germany-mask.geojson",
      "http://host/geo/germany-outline.geojson",
      "http://host/geo/laender.geojson",
      "http://host/geo/neighbours.geojson",
    ]);
    expect(files.data.mask).toEqual(collection("germany-mask.geojson"));
    expect(files.data.laender).toEqual(collection("laender.geojson"));
  });

  it("fetches each Land mask once and holds it", async () => {
    const fetchJson = served();
    const files = new GeoFiles("http://host", fetchJson);

    await Promise.all([files.landMask("DE-BY"), files.landMask("DE-BY")]);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith("http://host/geo/laender-masks/DE-BY.geojson");
    expect(files.data.landMasks?.["DE-BY"]).toEqual(collection("laender-masks/DE-BY.geojson"));
  });

  it("leaves a file that failed out and tries it again next time", async () => {
    const fetchJson = served(["neighbours.geojson"]);
    const files = new GeoFiles("http://host", fetchJson);

    const geo = await files.national();

    expect(geo.neighbours).toBeUndefined();
    expect(geo.mask).toBeDefined();
    await files.national();
    expect(fetchJson.mock.calls.filter(([url]) => url.endsWith("neighbours.geojson"))).toHaveLength(
      2,
    );
  });
});
