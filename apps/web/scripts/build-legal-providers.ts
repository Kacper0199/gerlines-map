import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderRow } from "../src/legal/model.ts";

const VERSATILES_URL = "https://versatiles.org/sources/";
const MAPTERHORN_URL = "https://download.mapterhorn.com/attribution.json";
const USAGE = `usage: node apps/web/scripts/build-legal-providers.ts <versatiles-sources.html> <mapterhorn-attribution.json> <checked YYYY-MM-DD>

Fetch the inputs first (with the project User-Agent):
  ${VERSATILES_URL}
  ${MAPTERHORN_URL}
Writes apps/web/src/legal/providers.ts; run biome format on it afterwards.`;

const ORTHOPHOTO_COVERAGE = new Set([
  "Belgique/België",
  "Česko",
  "Danmark",
  "France",
  "Hrvatska",
  "Liechtenstein",
  "Luxembourg",
  "Nederland",
  "Österreich",
  "Schweiz/Suisse/Svizzera",
]);
const GERMANY_PREFIX = "Deutschland - ";

const ELEVATION_COUNTRIES: readonly (readonly [RegExp, string])[] = [
  [/^de/, "Deutschland"],
  [/^at/, "Österreich"],
  [/^be/, "Belgique/België"],
  [/^(chzh|swissalti3d)$/, "Schweiz/Suisse/Svizzera"],
  [/^cz$/, "Česko"],
  [/^dk$/, "Danmark"],
  [/^fr(hd|rgealti[15]metro)/, "France"],
  [/^lu$/, "Luxembourg"],
  [/^nlahn/, "Nederland"],
  [/^pl[15]$/, "Polska"],
  [/^glo30$/, ""],
];

interface MapterhornSource {
  readonly source: string;
  readonly name: string;
  readonly website: string;
  readonly license: string;
  readonly producer: string;
  readonly license_pdf: string;
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cell(html: string): { text: string; href: string | null } {
  const href = /href="([^"]+)"/.exec(html)?.[1] ?? null;
  return { text: decode(html), href: href === null ? null : decode(href) };
}

function versatilesSections(html: string): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  for (const part of html.split("<h2").slice(1)) {
    const title = decode(part.slice(part.indexOf(">") + 1, part.indexOf("</h2>")));
    const rows = [...part.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...(row[1] ?? "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1] ?? ""),
    );
    sections.set(title, rows.slice(1));
  }
  return sections;
}

function versatilesRow(cells: string[], coverage: string): ProviderRow {
  const source = cell(cells[1] ?? "");
  const licence = cell(cells[2] ?? "");
  return {
    coverage,
    provider: source.text,
    dataset: null,
    url: source.href,
    licence: licence.text,
    licenceUrl: licence.href,
  };
}

export function imageryRows(html: string): ProviderRow[] {
  const sections = versatilesSections(html);
  const satellite = sections.get("Satellite Data") ?? [];
  const orthophotos = sections.get("Orthophotos") ?? [];
  if (satellite.length === 0 || orthophotos.length === 0) {
    throw new Error("the VersaTiles page has no Satellite Data or Orthophotos table");
  }
  const rows = satellite.map((cells) => versatilesRow(cells, ""));
  for (const cells of orthophotos) {
    const coverage = cell(cells[0] ?? "").text;
    if (coverage.startsWith(GERMANY_PREFIX)) {
      rows.push(versatilesRow(cells, coverage.slice(GERMANY_PREFIX.length)));
    } else if (ORTHOPHOTO_COVERAGE.has(coverage)) {
      rows.push(versatilesRow(cells, coverage));
    }
  }
  return rows;
}

export function elevationRows(sources: readonly MapterhornSource[]): ProviderRow[] {
  const rows: ProviderRow[] = [];
  const seen = new Set<string>();
  for (const [pattern, coverage] of ELEVATION_COUNTRIES) {
    for (const source of sources.filter((entry) => pattern.test(entry.source))) {
      const key = [
        coverage,
        source.producer.trim(),
        source.name.trim(),
        source.license.trim(),
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        coverage,
        provider: source.producer.trim(),
        dataset: source.name.trim(),
        url: source.website || null,
        licence: source.license.trim(),
        licenceUrl: source.license_pdf || null,
      });
    }
  }
  return rows;
}

function main(argv: readonly string[]): void {
  const [htmlPath, jsonPath, checked] = argv;
  if (!htmlPath || !jsonPath || !checked || !/^\d{4}-\d{2}-\d{2}$/.test(checked)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const imagery = imageryRows(readFileSync(htmlPath, "utf8"));
  const elevation = elevationRows(JSON.parse(readFileSync(jsonPath, "utf8")));
  if (elevation.filter((row) => row.coverage === "Deutschland").length < 16) {
    throw new Error("fewer than 16 German elevation sources: check the Mapterhorn list");
  }
  const out = resolve(import.meta.dirname, "../src/legal/providers.ts");
  const body = `import type { ProviderRow } from "./model.ts";

export const PROVIDERS_CHECKED = ${JSON.stringify(checked)};
export const VERSATILES_SOURCES_URL = ${JSON.stringify(VERSATILES_URL)};
export const MAPTERHORN_SOURCES_URL = "https://mapterhorn.com/attribution/";

/** Satellite and orthophoto providers of the VersaTiles satellite tiles inside the map's detail bounds. Generated by scripts/build-legal-providers.ts. */
export const IMAGERY_ROWS: readonly ProviderRow[] = ${JSON.stringify(imagery)};

/** Elevation sources of the Mapterhorn tiles for Germany, its neighbours and the global fill. Generated by scripts/build-legal-providers.ts. */
export const ELEVATION_ROWS: readonly ProviderRow[] = ${JSON.stringify(elevation)};
`;
  writeFileSync(out, body);
  process.stdout.write(
    `${out}: ${imagery.length} imagery rows, ${elevation.length} elevation rows\n`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
