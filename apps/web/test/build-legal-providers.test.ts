import { describe, expect, it } from "vitest";
import { elevationRows, imageryRows } from "../scripts/build-legal-providers.ts";

const HTML = `<h2>Satellite Data</h2><table><tr><th>Coverage</th><th>Data Source</th><th>License</th></tr>
<tr><td>Global</td><td><a href="https://s2gm.land.copernicus.eu/">Sentinel-2 Global Mosaic</a></td><td><a href="https://creativecommons.org/licenses/by/4.0/">CC-BY 4.0</a></td></tr></table>
<h2>Orthophotos</h2><table><tr><th>Coverage</th><th>Data Source</th><th>License</th></tr>
<tr><td>Deutschland - Bayern</td><td><a href="https://geodaten.bayern.de/a?x=1&amp;y=2">Bayerische Vermessungsverwaltung</a></td><td>CC BY 4.0</td></tr>
<tr><td>Nederland</td><td><a href="https://www.beeldmateriaal.nl/">beeldmateriaal.nl</a></td><td>CC BY 4.0</td></tr>
<tr><td>Portugal</td><td>DGT</td><td>CC BY 4.0</td></tr></table>`;

const SOURCE = {
  name: "DGM1",
  website: "https://example.org/dgm1",
  license: "CC BY 4.0",
  producer: "Producer ",
  license_pdf: "https://example.org/LICENSE.pdf",
};

describe("build-legal-providers", () => {
  it("keeps the satellite rows, the German orthophotos and the neighbours only", () => {
    const rows = imageryRows(HTML);
    expect(rows.map((row) => row.coverage)).toEqual(["", "Bayern", "Nederland"]);
    expect(rows[1]).toEqual({
      coverage: "Bayern",
      provider: "Bayerische Vermessungsverwaltung",
      dataset: null,
      url: "https://geodaten.bayern.de/a?x=1&y=2",
      licence: "CC BY 4.0",
      licenceUrl: null,
    });
  });

  it("refuses a page without the expected tables", () => {
    expect(() => imageryRows("<h2>Vector Data</h2>")).toThrow(/Orthophotos/);
  });

  it("keeps German, neighbour and global elevation sources in country order", () => {
    const rows = elevationRows([
      { ...SOURCE, source: "glo30", producer: "DLR" },
      { ...SOURCE, source: "us1aa" },
      { ...SOURCE, source: "pl1" },
      { ...SOURCE, source: "debayern" },
      { ...SOURCE, source: "debayern2" },
      { ...SOURCE, source: "dkgreenland" },
    ]);
    expect(rows.map((row) => [row.coverage, row.provider])).toEqual([
      ["Deutschland", "Producer"],
      ["Polska", "Producer"],
      ["", "DLR"],
    ]);
  });
});
