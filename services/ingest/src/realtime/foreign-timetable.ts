import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { gtfsTimeToSeconds } from "@gerlines/schema/service-day";
import { NO_TIME, type Timetable } from "./timetable.ts";
import { forEachCsvRow, ZipArchive } from "./zip.ts";

export interface ForeignTrip {
  readonly tripId: string;
  readonly routeShortName: string | null;
  /** Stop ids in stop sequence order. */
  readonly stopIds: readonly string[];
  /** Scheduled seconds of each stop on its service day: the departure, else the arrival, else `NO_TIME`. */
  readonly times: Int32Array;
}

/** Another source's own timetable, used to read its realtime ids (trip ids and stop ids). */
export interface ForeignTimetable {
  trip(tripId: string): ForeignTrip | undefined;
  placeOfStop(stopId: string): string | undefined;
}

const MAX_PLACE_DISTANCE_M = 400;
const CELL_DEGREES = 0.01;

function distanceMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/** Nearest stop place of the timetable within 400 m of a point, through a 0.01 degree grid. */
export class PlaceLocator {
  private readonly cells = new Map<string, { id: string; lat: number; lon: number }[]>();

  constructor(timetable: Timetable) {
    for (const [id, place] of timetable.data.stopPlaces) {
      if (place.lat === null || place.lon === null) continue;
      const key = this.cell(place.lat, place.lon);
      const list = this.cells.get(key) ?? [];
      list.push({ id, lat: place.lat, lon: place.lon });
      this.cells.set(key, list);
    }
  }

  private cell(lat: number, lon: number, dLat = 0, dLon = 0): string {
    return `${Math.floor(lat / CELL_DEGREES) + dLat}|${Math.floor(lon / CELL_DEGREES) + dLon}`;
  }

  nearest(lat: number, lon: number): string | undefined {
    let best: { id: string; distance: number } | undefined;
    for (const dLat of [-1, 0, 1]) {
      for (const dLon of [-1, 0, 1]) {
        for (const place of this.cells.get(this.cell(lat, lon, dLat, dLon)) ?? []) {
          const distance = distanceMetres(lat, lon, place.lat, place.lon);
          if (distance <= MAX_PLACE_DISTANCE_M && (!best || distance < best.distance)) {
            best = { id: place.id, distance };
          }
        }
      }
    }
    return best?.id;
  }
}

interface StopRow {
  readonly parent: string;
  readonly lat: number;
  readonly lon: number;
}

/**
 * A copy of a string that shares no memory with the text it was cut from: V8 keeps a substring of 13
 * or more characters as a slice of its parent, so one kept stop id would pin a whole stop_times.txt.
 */
const ownCopy = (text: string): string => Buffer.from(text, "utf8").toString("utf8");

/** One string per distinct value, each an own copy. */
class Interner {
  private readonly values = new Map<string, string>();

  of(text: string): string {
    let value = this.values.get(text);
    if (value === undefined) {
      value = ownCopy(text);
      this.values.set(value, value);
    }
    return value;
  }

  get size(): number {
    return this.values.size;
  }
}

interface StopTimeRow {
  readonly sequence: number;
  readonly stopId: string;
  readonly seconds: number;
}

/** gtfs.de rail timetables (`gtfsde-static-rv`, `-fv`) as the key to gtfs.de realtime ids. */
export class GtfsdeTimetable implements ForeignTimetable {
  private readonly trips = new Map<string, ForeignTrip>();
  private readonly places = new Map<string, string>();
  private readonly stopIds = new Interner();
  readonly files: readonly string[];

  private constructor(files: readonly string[]) {
    this.files = files;
  }

  static async load(files: readonly string[], timetable: Timetable): Promise<GtfsdeTimetable> {
    const result = new GtfsdeTimetable(files);
    const locator = new PlaceLocator(timetable);
    for (const file of files) result.read(await ZipArchive.open(file), locator);
    return result;
  }

  static fromArchives(archives: readonly ZipArchive[], timetable: Timetable): GtfsdeTimetable {
    const result = new GtfsdeTimetable([]);
    const locator = new PlaceLocator(timetable);
    for (const archive of archives) result.read(archive, locator);
    return result;
  }

  trip(tripId: string): ForeignTrip | undefined {
    return this.trips.get(tripId);
  }

  placeOfStop(stopId: string): string | undefined {
    return this.places.get(stopId);
  }

  get tripCount(): number {
    return this.trips.size;
  }

  get distinctStopIds(): number {
    return this.stopIds.size;
  }

  private read(archive: ZipArchive, locator: PlaceLocator): void {
    const stops = new Map<string, StopRow>();
    forEachCsvRow(archive.read("stops.txt").toString("utf8"), (fields, column) => {
      stops.set(fields[column("stop_id")] ?? "", {
        parent: fields[column("parent_station")] ?? "",
        lat: Number(fields[column("stop_lat")]),
        lon: Number(fields[column("stop_lon")]),
      });
    });
    for (const [id, stop] of stops) {
      const station = stops.get(stop.parent) ?? stop;
      const place =
        locator.nearest(station.lat, station.lon) ?? locator.nearest(stop.lat, stop.lon);
      if (place) this.places.set(this.stopIds.of(id), place);
    }
    const names = new Interner();
    const routeNames = new Map<string, string>();
    forEachCsvRow(archive.read("routes.txt").toString("utf8"), (fields, column) => {
      routeNames.set(
        fields[column("route_id")] ?? "",
        names.of(fields[column("route_short_name")] ?? ""),
      );
    });
    const tripRoutes = new Map<string, string>();
    forEachCsvRow(archive.read("trips.txt").toString("utf8"), (fields, column) => {
      tripRoutes.set(fields[column("trip_id")] ?? "", fields[column("route_id")] ?? "");
    });
    const stopTimes = new Map<string, StopTimeRow[]>();
    forEachCsvRow(archive.read("stop_times.txt").toString("utf8"), (fields, column) => {
      const tripId = fields[column("trip_id")] ?? "";
      const list = stopTimes.get(tripId) ?? [];
      const seconds =
        gtfsTimeToSeconds(fields[column("departure_time")] ?? "") ??
        gtfsTimeToSeconds(fields[column("arrival_time")] ?? "");
      list.push({
        sequence: Number(fields[column("stop_sequence")]),
        stopId: this.stopIds.of(fields[column("stop_id")] ?? ""),
        seconds: seconds ?? NO_TIME,
      });
      stopTimes.set(tripId, list);
    });
    for (const [tripId, list] of stopTimes) {
      const route = tripRoutes.get(tripId);
      list.sort((a, b) => a.sequence - b.sequence);
      const own = ownCopy(tripId);
      this.trips.set(own, {
        tripId: own,
        routeShortName: (route && routeNames.get(route)) || null,
        stopIds: list.map((row) => row.stopId),
        times: Int32Array.from(list, (row) => row.seconds),
      });
    }
  }
}

/** The newest recorded static file of a source (`<date>/<HHMMSS>Z-<name>`) at or before an instant. */
export async function recordedStaticFile(
  root: string,
  source: string,
  atOrBefore: number,
): Promise<string | undefined> {
  const dates = (await readdir(join(root, source)).catch(() => [] as string[]))
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
  const limit = new Date(atOrBefore).toISOString();
  for (const date of dates) {
    const files = (await readdir(join(root, source, date)))
      .filter((name) => /^\d{6}Z-.+\.zip$/.test(name))
      .sort()
      .reverse();
    for (const name of files) {
      const stamp = `${date}T${name.slice(0, 2)}:${name.slice(2, 4)}:${name.slice(4, 6)}.000Z`;
      if (stamp <= limit) return join(root, source, date, name);
    }
  }
  return undefined;
}
