import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Category, Keyframe, ShapePack, StopRecord, TripRecord } from "../src/index.ts";
import { random } from "./synthetic.ts";

/** Splits one CSV line, honouring double quotes. */
export function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else field += c;
  }
  fields.push(field);
  return fields;
}

function seconds(time: string): number {
  const [h = "0", m = "0", s = "0"] = time.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function categoryOf(name: string, routeType: number): Category {
  if (/^(ICE|TGV|RJX|ECE)/.test(name)) return "hsr";
  if (/^(NJ|EN|\d+N$)/.test(name) || routeType === 105) return "night";
  if (/^(IC|EC|FLX|RJ)/.test(name) || routeType === 101 || routeType === 102) return "ld";
  if (/^(RE|IRE|MEX|FEX)/.test(name)) return "rfast";
  if (/^S/.test(name) || routeType === 109) return "sbahn";
  return "reg";
}

function fnvHex(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

async function lines(path: string, each: (line: string) => void): Promise<void> {
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let first = true;
  for await (const line of reader) {
    if (first) first = false;
    else if (line) each(line);
  }
}

interface TripInfo {
  readonly line: string;
  readonly category: Category;
  readonly trainNumber: number | null;
  readonly shapeId: string;
  readonly shapeNumber: number;
  readonly routeId: string;
}

function shapeNumberOf(numbers: Map<string, number>, key: string): number {
  let value = numbers.get(key);
  if (value === undefined) {
    value = numbers.size + 1;
    numbers.set(key, value);
  }
  return value;
}

async function tripInfo(directory: string): Promise<Map<string, TripInfo>> {
  const routes = new Map<string, { name: string; type: number }>();
  await lines(`${directory}/routes.txt`, (line) => {
    const f = csvFields(line);
    routes.set(f[0] as string, { name: f[2] as string, type: Number(f[5]) });
  });
  const trips = new Map<string, TripInfo>();
  const shapeNumbers = new Map<string, number>();
  await lines(`${directory}/trips.txt`, (line) => {
    const f = csvFields(line);
    const route = routes.get(f[0] as string) ?? { name: "", type: 2 };
    const number = Number.parseInt(f[4] as string, 10);
    trips.set(f[2] as string, {
      line: route.name,
      category: categoryOf(route.name, route.type),
      trainNumber: number > 0 ? number : null,
      shapeId: fnvHex(f[7] as string),
      shapeNumber: shapeNumberOf(shapeNumbers, f[7] as string),
      routeId: f[0] as string,
    });
  });
  return trips;
}

async function stopTimes(directory: string): Promise<Map<string, number[]>> {
  const times = new Map<string, number[]>();
  await lines(`${directory}/stop_times.txt`, (line) => {
    const [trip = "", arrival = "", departure = ""] = line.split(",", 3);
    let list = times.get(trip);
    if (!list) {
      list = [];
      times.set(trip, list);
    }
    list.push(seconds(arrival), seconds(departure));
  });
  return times;
}

export interface GtfsSample {
  readonly running: number;
  readonly keyframe: (count: number, seed: number, numbered?: boolean) => Keyframe;
}

/**
 * Trips of a GTFS feed running at `timeOfDay` (seconds), calendars ignored and repeats of one train
 * on other days folded, with their real stop times from the last departed stop on. Realtime is
 * simulated (75 % of trips, delays 0, whole minutes or any second up to 30 min).
 */
interface RunningTrip {
  readonly info: TripInfo;
  readonly times: readonly number[];
  readonly from: number;
}

function simulatedDelay(next: () => number, realtime: boolean): number {
  const u = next();
  if (!realtime || u < 0.55) return 0;
  return u < 0.85 ? 60 * (1 + Math.floor(next() * 5)) : 30 + Math.floor(next() * 1770);
}

function plannedStops(trip: RunningTrip, shift: number, realtime: boolean): StopRecord[] {
  const total = trip.times.length / 2;
  const stops: StopRecord[] = [];
  let previous = 0;
  for (let j = trip.from; j < total; j++) {
    const arrival = Math.max(previous, (trip.times[2 * j] as number) + shift);
    const departure = Math.max(arrival, (trip.times[2 * j + 1] as number) + shift);
    previous = departure;
    stops.push({
      arrival: j === 0 ? null : arrival,
      departure: j === total - 1 ? null : departure,
      cancelled: false,
      realtime: realtime && j > trip.from,
      s: null,
    });
  }
  return stops;
}

function runningTrips(
  info: Map<string, TripInfo>,
  times: Map<string, number[]>,
  timeOfDay: number,
): RunningTrip[] {
  const seen = new Set<string>();
  const running: RunningTrip[] = [];
  for (const [id, list] of times) {
    const trip = info.get(id);
    const last = list.at(-2) as number;
    if (!trip || list.length < 4 || (list[1] as number) > timeOfDay || timeOfDay >= last) continue;
    const fold = `${trip.routeId}|${trip.trainNumber}|${list[1]}`;
    if (seen.has(fold)) continue;
    seen.add(fold);
    let from = 0;
    while (from + 1 < list.length / 2 && (list[2 * (from + 1) + 1] as number) <= timeOfDay) from++;
    running.push({ info: trip, times: list, from });
  }
  return running;
}

/**
 * Trips of a GTFS feed running at `timeOfDay` (seconds), calendars ignored and repeats of one train
 * on other days folded, with their real stop times from the last departed stop on. Realtime is
 * simulated (75 % of trips, delays 0, whole minutes or any second up to 30 min). Shapes are named
 * by a hash prefix of the GTFS shape id, or with `numbered` by its position in the feed.
 */
export async function gtfsSample(
  directory: string,
  timeOfDay: number,
  timeBase: number,
): Promise<GtfsSample> {
  const running = runningTrips(await tripInfo(directory), await stopTimes(directory), timeOfDay);
  return {
    running: running.length,
    keyframe(count, seed, numbered = false) {
      const next = random(seed);
      const order = running.map((trip) => ({ trip, sortKey: next() }));
      order.sort((a, b) => a.sortKey - b.sortKey);
      const trips = order.slice(0, count).map(({ trip }, i): TripRecord => {
        const realtime = next() < 0.75;
        const delay = simulatedDelay(next, realtime);
        return {
          key: 1_000_000 + i * 3,
          shapeId: numbered ? trip.info.shapeNumber : trip.info.shapeId,
          category: trip.info.category,
          realtime,
          cancelled: false,
          foreign: false,
          delay: realtime ? delay : null,
          line: trip.info.line || null,
          trainNumber: trip.info.trainNumber,
          firstStop: trip.from,
          stops: plannedStops(trip, timeBase - timeOfDay + delay, realtime),
        };
      });
      const shapeEpoch = numbered ? 1 : 0;
      return { kind: "keyframe", sequence: 1, timetableVersion: 1, shapeEpoch, timeBase, trips };
    },
  };
}

const EARTH_RADIUS = 6_378_137;

/**
 * A shape pack for one trip of SP-3's MOTIS shapes (`shapes/motis.json`: trip id to [lon, lat]
 * points). Stops are spread over the arc length with the given count; elevation, when asked, is a
 * seeded smooth profile (WP-2.2 bakes the real one), so the z column has realistic entropy.
 */
export function motisShapePack(
  path: string,
  tripId: string,
  stopCount: number,
  elevation: boolean,
): ShapePack {
  const shapes = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    [number, number][] | null
  >;
  const points = shapes[tripId];
  if (!points) throw new RangeError(`no MOTIS shape for trip ${tripId}`);
  const rad = Math.PI / 180;
  const x = points.map(([lon]) => Math.round(EARTH_RADIUS * lon * rad * 100) / 100);
  const y = points.map(
    ([, lat]) =>
      Math.round(EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)) * 100) / 100,
  );
  let ground = 0;
  const m = points.map((point, i) => {
    if (i > 0) {
      const [lon0, lat0] = points[i - 1] as [number, number];
      const [lon1, lat1] = point;
      const dx = (lon1 - lon0) * rad * Math.cos(((lat0 + lat1) / 2) * rad);
      ground += 6_371_008.8 * Math.hypot(dx, (lat1 - lat0) * rad);
    }
    return Math.round(ground * 100) / 100;
  });
  const length = m.at(-1) ?? 0;
  const next = random(7);
  let z = 120;
  return {
    kind: "shapePack",
    timetableVersion: 1,
    shapeEpoch: 0,
    shapes: [
      {
        hash: fnvHex(tripId).repeat(4),
        number: null,
        x,
        y,
        z: elevation
          ? points.map(() => {
              z = Math.min(900, Math.max(0, z + (next() - 0.5) * 2));
              return Math.fround(Math.round(z * 10) / 10);
            })
          : null,
        m,
        length,
        stops: Array.from(
          { length: stopCount },
          (_, j) => Math.round((length * j * 100) / (stopCount - 1)) / 100,
        ),
        tunnels: [],
      },
    ],
  };
}
