import { readFile } from "node:fs/promises";
import type { PlaceRecord } from "./records.ts";

const COLUMNS = [
  "id",
  "type",
  "name_en",
  "name_de",
  "name_pl",
  "region_en",
  "region_de",
  "region_pl",
  "land_code",
  "lon",
  "lat",
  "west",
  "south",
  "east",
  "north",
  "rank",
] as const;

export class PlacesFileError extends Error {
  override readonly name = "PlacesFileError";
}

function number(value: string, line: number): number {
  const parsed = Number(value);
  if (value === "" || !Number.isFinite(parsed)) {
    throw new PlacesFileError(`line ${line}: ${JSON.stringify(value)} is not a number`);
  }
  return parsed;
}

/** Parses the places file written by `scripts/build_places.py` (tab separated, one header row). */
export function parsePlaces(text: string): PlaceRecord[] {
  const [header, ...lines] = text.split("\n").filter((line) => line !== "");
  if (header !== COLUMNS.join("\t")) {
    throw new PlacesFileError("the places file does not start with the expected header");
  }
  return lines.map((line, i) => {
    const at = i + 2;
    const cells = line.split("\t");
    if (cells.length !== COLUMNS.length) {
      throw new PlacesFileError(`line ${at}: ${cells.length} cells, ${COLUMNS.length} expected`);
    }
    const row = Object.fromEntries(COLUMNS.map((name, j) => [name, cells[j] ?? ""])) as Record<
      (typeof COLUMNS)[number],
      string
    >;
    if (row.type !== "land" && row.type !== "town") {
      throw new PlacesFileError(`line ${at}: unknown place type ${row.type}`);
    }
    const boxed = row.west !== "";
    return {
      id: row.id,
      type: row.type,
      names: { en: row.name_en, de: row.name_de, pl: row.name_pl },
      region:
        row.region_de === "" ? null : { en: row.region_en, de: row.region_de, pl: row.region_pl },
      landCode: row.land_code === "" ? null : row.land_code,
      lon: number(row.lon, at),
      lat: number(row.lat, at),
      bbox: boxed
        ? [number(row.west, at), number(row.south, at), number(row.east, at), number(row.north, at)]
        : null,
      rank: number(row.rank, at),
    };
  });
}

export async function readPlaces(path: string): Promise<PlaceRecord[]> {
  return parsePlaces(await readFile(path, "utf8"));
}
