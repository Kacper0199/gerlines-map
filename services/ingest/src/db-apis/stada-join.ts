import { readFile } from "node:fs/promises";
import { createDatabase, resolveDatabaseUrl, withDatabase } from "@gerlines/db";
import { sql } from "kysely";
import { parseStadaStations, type StadaStation } from "./stada.ts";

export interface OurStopPlace {
  readonly stopPlaceId: string;
  readonly name: string;
  readonly dhid: string | null;
  readonly eva: number | null;
}

export interface JoinInput {
  readonly stopPlaces: readonly OurStopPlace[];
  /** `id_map` rows of source `traines-delfi-eva`: EVA number to canonical stop place. */
  readonly evaMap: ReadonlyMap<number, string>;
}

export type JoinOutcome =
  | "agree"
  | "agree-by-eva-only"
  | "agree-by-ifopt-only"
  | "differ"
  | "ours-without-eva"
  | "missing";

export interface JoinRow {
  readonly stationNumber: number;
  readonly name: string;
  readonly mainEva: number | null;
  readonly ifopt: string | null;
  readonly outcome: JoinOutcome;
  readonly ourName: string | null;
  readonly ourEva: number | null;
}

/**
 * Joins StaDa stations with our stop places two ways: the main EVA number through `id_map`, and the StaDa
 * IFOPT through the stop place's DHID. Both agree when they reach the same stop place, or when the IFOPT
 * reaches a stop place that carries the same EVA number.
 */
export function joinStada(stations: readonly StadaStation[], ours: JoinInput): JoinRow[] {
  const byId = new Map(ours.stopPlaces.map((place) => [place.stopPlaceId, place]));
  const byDhid = new Map(
    ours.stopPlaces.filter((place) => place.dhid !== null).map((place) => [place.dhid, place]),
  );
  return stations.map((station) => {
    const viaEvaId = station.mainEva === null ? undefined : ours.evaMap.get(station.mainEva);
    const viaEva = viaEvaId === undefined ? undefined : byId.get(viaEvaId);
    const viaIfopt = station.ifopt === null ? undefined : byDhid.get(station.ifopt);
    const outcome = classify(station, viaEva, viaIfopt);
    const matched = viaIfopt ?? viaEva;
    return {
      stationNumber: station.stationNumber,
      name: station.name,
      mainEva: station.mainEva,
      ifopt: station.ifopt,
      outcome,
      ourName: matched?.name ?? null,
      ourEva: matched?.eva ?? null,
    };
  });
}

function classify(
  station: StadaStation,
  viaEva: OurStopPlace | undefined,
  viaIfopt: OurStopPlace | undefined,
): JoinOutcome {
  if (viaIfopt && viaEva) {
    return viaIfopt.stopPlaceId === viaEva.stopPlaceId || viaIfopt.eva === station.mainEva
      ? "agree"
      : "differ";
  }
  if (viaEva) return "agree-by-eva-only";
  if (viaIfopt) {
    if (viaIfopt.eva === null) return "ours-without-eva";
    return viaIfopt.eva === station.mainEva ? "agree-by-ifopt-only" : "differ";
  }
  return "missing";
}

export interface JoinReport {
  readonly stadaStations: number;
  readonly stadaWithMainEva: number;
  readonly ourStopPlaces: number;
  readonly ourStopPlacesWithEva: number;
  readonly outcomes: Readonly<Record<JoinOutcome, number>>;
  readonly ourEvaNotInStada: number;
  readonly samples: Readonly<Partial<Record<JoinOutcome, readonly JoinRow[]>>>;
}

export function summariseJoin(
  stations: readonly StadaStation[],
  ours: JoinInput,
  rows: readonly JoinRow[],
): JoinReport {
  const outcomes: Record<JoinOutcome, number> = {
    agree: 0,
    "agree-by-eva-only": 0,
    "agree-by-ifopt-only": 0,
    differ: 0,
    "ours-without-eva": 0,
    missing: 0,
  };
  for (const row of rows) outcomes[row.outcome] += 1;
  const stadaEvas = new Set(stations.flatMap((station) => station.evaNumbers.map((e) => e.eva)));
  const ourEvas = new Set(
    ours.stopPlaces.flatMap((place) => (place.eva === null ? [] : [place.eva])),
  );
  return {
    stadaStations: stations.length,
    stadaWithMainEva: stations.filter((station) => station.mainEva !== null).length,
    ourStopPlaces: ours.stopPlaces.length,
    ourStopPlacesWithEva: ours.stopPlaces.filter((place) => place.eva !== null).length,
    outcomes,
    ourEvaNotInStada: [...ourEvas].filter((eva) => !stadaEvas.has(eva)).length,
    samples: {
      differ: rows.filter((row) => row.outcome === "differ").slice(0, 10),
      "ours-without-eva": rows.filter((row) => row.outcome === "ours-without-eva").slice(0, 5),
      missing: rows.filter((row) => row.outcome === "missing").slice(0, 10),
    },
  };
}

/** Reads `stop_place` and the EVA `id_map` of WP-2.1's database (read only; default `gerlines_wp21`). */
export async function loadOurStops(
  env: Readonly<Record<string, string | undefined>>,
): Promise<JoinInput> {
  const url = withDatabase(resolveDatabaseUrl(env), env.STADA_JOIN_DATABASE ?? "gerlines_wp21");
  const db = createDatabase({
    databaseUrl: url,
    applicationName: "gerlines-wp24-stada-join",
    maxConnections: 1,
  });
  try {
    const places = await sql<{
      stop_place_id: string;
      name: string;
      dhid: string | null;
      eva: number | null;
    }>`
      SELECT stop_place_id, name, dhid, eva FROM stop_place`.execute(db);
    const evas = await sql<{ source_key: string; canonical_id: string }>`
      SELECT source_key, canonical_id FROM id_map
      WHERE source_id = 'traines-delfi-eva' AND entity = 'stop_place'`.execute(db);
    return {
      stopPlaces: places.rows.map((row) => ({
        stopPlaceId: row.stop_place_id,
        name: row.name,
        dhid: row.dhid,
        eva: row.eva,
      })),
      evaMap: new Map(evas.rows.map((row) => [Number(row.source_key), row.canonical_id])),
    };
  } finally {
    await db.destroy();
  }
}

export async function stadaJoinReport(
  file: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<JoinReport> {
  const { stations } = parseStadaStations(await readFile(file));
  const ours = await loadOurStops(env);
  return summariseJoin(stations, ours, joinStada(stations, ours));
}
