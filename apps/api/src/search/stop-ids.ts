import { foldText } from "./fold.ts";

/** One served station with what the timetable tables say about its feed stop id. */
export interface StopIdCandidate {
  readonly id: string;
  readonly name: string;
  readonly eva: number | null;
  readonly dhid: string | null;
  readonly lon: number;
  readonly lat: number;
  readonly stopId: string | null;
  /**
   * The station is served by the newest loaded version of the feed. Assumes the router runs on that
   * version: load a feed into the search database and import it into the router together.
   */
  readonly inNewestFeed: boolean;
  /**
   * When a load last saw the stop id in `id_map` (epoch ms), null when it is no key there. It follows
   * the order of loads, not `published_on`, so an older DELFI version loaded again would look newest.
   */
  readonly stopIdSeenMs: number | null;
  /**
   * The stop id is a `location_type` 0 row of the feed's stops.txt (a `stop_point` key in `id_map`).
   * A parent station is a row MOTIS accepts too, but only a `stop_place` key, so it is false there.
   */
  readonly stopIdIsRow: boolean;
  /**
   * The stop id is a place the importer built from platform ids, with no stops.txt row, so a
   * router does not hold it; a parent station row (location_type 1) is not.
   */
  readonly stopIdSynthesised: boolean;
  readonly trainsToday: number;
}

const FAMILY_RADIUS_M = 1_000;
const EARTH_RADIUS_M = 6_371_000;
const DHID = /^([a-z]{2}):[0-9]{5}:([0-9A-Za-z_]+)$/;

/** The DHID without its district key: district twins such as `de:03152:33817` and `de:03159:33817` meet. */
function twinKey(dhid: string | null): string | null {
  const match = dhid === null ? null : DHID.exec(dhid);
  return match ? `${match[1]}:${match[2]}` : null;
}

function distanceM(a: StopIdCandidate, b: StopIdCandidate): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Two stop places of one station: one name, one EVA number or DHIDs that differ only in the district, close by. */
function sameStation(a: StopIdCandidate, b: StopIdCandidate): boolean {
  const twin = twinKey(a.dhid);
  return (
    ((a.eva !== null && a.eva === b.eva) || (twin !== null && twin === twinKey(b.dhid))) &&
    distanceM(a, b) <= FAMILY_RADIUS_M
  );
}

/** Positive when `a`'s stop id is the better router stop on the feed's evidence alone, 0 on a tie. */
function evidence(a: StopIdCandidate, b: StopIdCandidate): number {
  if (a.inNewestFeed !== b.inNewestFeed) return a.inNewestFeed ? 1 : -1;
  const seenA = a.stopIdSeenMs ?? Number.NEGATIVE_INFINITY;
  const seenB = b.stopIdSeenMs ?? Number.NEGATIVE_INFINITY;
  if (seenA !== seenB) return seenA > seenB ? 1 : -1;
  if (a.stopIdSynthesised !== b.stopIdSynthesised) return a.stopIdSynthesised ? -1 : 1;
  if (a.stopIdIsRow !== b.stopIdIsRow) return a.stopIdIsRow ? 1 : -1;
  return 0;
}

function better(a: StopIdCandidate, b: StopIdCandidate): number {
  const idA = a.stopId ?? "";
  const idB = b.stopId ?? "";
  return evidence(a, b) || a.trainsToday - b.trainsToday || (idA < idB ? 1 : idA > idB ? -1 : 0);
}

function familyKeys(station: StopIdCandidate): string[] {
  const name = foldText(station.name);
  const twin = twinKey(station.dhid);
  return [
    ...(station.eva === null ? [] : [`eva ${station.eva} ${name}`]),
    ...(twin === null ? [] : [`dhid ${twin} ${name}`]),
  ];
}

function families<T extends StopIdCandidate>(stations: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const station of stations) {
    if (station.stopId === null) continue;
    for (const key of familyKeys(station)) {
      const members = groups.get(key);
      if (members) members.push(station);
      else groups.set(key, [station]);
    }
  }
  return [...groups.values()].filter((members) => members.length > 1);
}

function bestOf<T extends StopIdCandidate>(station: T, members: readonly T[], start: T): T {
  let best = start;
  for (const other of members) {
    if (other !== station && sameStation(station, other) && better(other, best) > 0) best = other;
  }
  return best;
}

/**
 * The stop id each station hands the router. Where one station has several stop places
 * (district twins such as Göttingen `de:03152:33817` and `de:03159:33817`, or two places with one
 * EVA number and one name), a stop place takes the stop id of its sibling when the feed's evidence
 * says that id is the better router stop: served by the newest loaded feed version, then seen
 * latest in `id_map`, then not a place the importer synthesised, then a `location_type` 0
 * row of stops.txt (a `stop_point` key). On a tie each
 * keeps its own id. Names, ranks and every other field stay as they are; only `stopId` changes, and
 * the answer does not depend on the order of `stations`. Families are not transitive: a place
 * compares the original ids of the places within 1 km of it, so of three places in a row more than
 * 1 km apart at the ends, the first may take the middle one's own id while the middle one takes the
 * last one's (no such triple on gerlines_wp32, 2026-11-09).
 */
export function familyStopIds<T extends StopIdCandidate>(stations: readonly T[]): T[] {
  const chosen = new Map<string, T>();
  for (const members of families(stations)) {
    for (const station of members) {
      chosen.set(station.id, bestOf(station, members, chosen.get(station.id) ?? station));
    }
  }
  return stations.map((station) => {
    const best = chosen.get(station.id);
    return best === undefined || evidence(best, station) <= 0
      ? station
      : { ...station, stopId: best.stopId };
  });
}
