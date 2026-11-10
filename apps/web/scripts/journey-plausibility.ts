import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userAgent } from "@gerlines/schema";

const USAGE = `usage: node --env-file=<.env> apps/web/scripts/journey-plausibility.ts <pairs.json> <stada.json> <cache dir> <out.json> [--fetch] [--max N] [--gap-ms MS] [--until YYMMDDHH]

Checks the journeys of journey-pairs.mjs against DB's own plan, DB Timetables (IRIS) plan slices of one station and
hour (DB API Marketplace, plan Free, K1, data CC BY 4.0 Deutsche Bahn AG). For the earliest journey of each pair,
every train leg must leave and reach each DB station with the same train within ${2} minutes of DB's planned time,
and when DB plans a direct train from origin to destination inside the answer's window, the answer must hold a
direct journey and no earlier direct train may arrive by the journey's arrival. Without --fetch it lists the slices
it still needs; with --fetch it asks for them (one request every --gap-ms, 2.1 s by default and never less, at most
--max this run, every request logged to <cache dir>/requests.jsonl) and writes the table to <out.json>. --until holds
back the slices after that German local hour (beyond DB's horizon), so a later run asks for them instead of finding
them refused.`;

export const TOLERANCE_MIN = 2;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NEAR_STATION_M = 400;
const DIRECT_WINDOW_HOURS = 3;
const REQUEST_GAP_MS = 2_100;
const IRIS_PLAN = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/plan";

export interface IrisEvent {
  readonly at: number;
  readonly line: string | null;
  readonly path: readonly string[];
}

export interface IrisStop {
  readonly category: string;
  readonly number: string;
  readonly arrival: IrisEvent | null;
  readonly departure: IrisEvent | null;
}

export interface LegStop {
  readonly stopId: string | null;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly scheduledTime: string | null;
}

export interface Leg {
  readonly category: string;
  readonly line: string | null;
  readonly tripNumber: string | null;
  readonly scheduledDeparture: string;
  readonly scheduledArrival: string;
  readonly from: LegStop;
  readonly to: LegStop;
}

export interface Journey {
  readonly departure: string;
  readonly arrival: string;
  readonly transfers: number;
  readonly legs: readonly Leg[];
}

export type EventCheck =
  | { readonly status: "within"; readonly deltaMin: number; readonly train: string }
  | { readonly status: "outside"; readonly deltaMin: number | null; readonly train: string | null }
  | { readonly status: "not_checkable"; readonly reason: string };

const SPECIAL = new Map([
  ["ß", "ss"],
  ["ł", "l"],
  ["đ", "d"],
  ["ø", "o"],
  ["æ", "ae"],
  ["œ", "oe"],
]);

/** A station name as IRIS paths and the pairs write it, compared without case, accents, spaces or brackets. */
export function foldStation(name: string): string {
  const lower = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  return [...lower]
    .map((char) => SPECIAL.get(char) ?? char)
    .join("")
    .replace(/([aou])e/g, "$1")
    .replace(/hauptbahnhof/g, "hbf")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A train number without leading zeros, as DELFI pads it (001028) and IRIS does not (1028). */
export function trainKey(number: string | null): string | null {
  const text =
    number
      ?.trim()
      .toUpperCase()
      .replace(/^0+(?=.)/, "") ?? "";
  return text === "" ? null : text;
}

const berlinParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsOf(at: number): Record<string, string> {
  return Object.fromEntries(berlinParts.formatToParts(at).map((part) => [part.type, part.value]));
}

/** The IRIS slice an instant falls in: date YYMMDD and hour HH in German local time. */
export function sliceOf(at: number): { readonly date: string; readonly hour: string } {
  const parts = partsOf(at);
  return { date: `${parts.year}${parts.month}${parts.day}`, hour: parts.hour ?? "00" };
}

/** An IRIS planned time YYMMDDHHmm (German local time) as an instant. */
export function irisInstant(text: string): number {
  const [yy, mo, dd, hh, mi] = [0, 2, 4, 6, 8].map((at) => Number(text.slice(at, at + 2)));
  const asUtc = Date.UTC(2000 + (yy ?? 0), (mo ?? 1) - 1, dd ?? 1, hh ?? 0, mi ?? 0);
  let at = asUtc;
  for (let round = 0; round < 2; round++) {
    const parts = partsOf(at);
    const shown = Date.UTC(
      2000 + Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    at += asUtc - shown;
  }
  return at;
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([\w-]+)="([^"]*)"/g)) {
    found[match[1] as string] = (match[2] as string)
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");
  }
  return found;
}

function eventOf(text: string | undefined): IrisEvent | null {
  if (text === undefined) return null;
  const event = attributes(text);
  if (!event.pt) return null;
  return {
    at: irisInstant(event.pt),
    line: event.l ?? null,
    path: event.ppth ? event.ppth.split("|") : [],
  };
}

/** The stops of one IRIS plan answer: train category and number, planned arrival and departure with their paths. */
export function parseIrisPlan(xml: string): IrisStop[] {
  const stops: IrisStop[] = [];
  for (const block of xml.matchAll(/<s\s[^>]*>([\s\S]*?)<\/s>/g)) {
    const body = block[1] as string;
    const label = attributes(/<tl\s([^>]*)\/?>/.exec(body)?.[1] ?? "");
    stops.push({
      category: label.c ?? "",
      number: label.n ?? "",
      arrival: eventOf(/<ar\s([^>]*?)\/?>/.exec(body)?.[1]),
      departure: eventOf(/<dp\s([^>]*?)\/?>/.exec(body)?.[1]),
    });
  }
  return stops;
}

function lineKeys(stop: IrisStop, event: IrisEvent): string[] {
  const line = event.line?.trim() ?? "";
  if (line === "") return [];
  return [foldStation(line), foldStation(`${stop.category}${line}`)];
}

/**
 * DB's planned event for one end of a leg: the stop with the same train number, else the stop of the same line
 * nearest in time. Within when DB's planned time is no more than the tolerance away.
 */
export function matchEvent(
  leg: Pick<Leg, "tripNumber" | "line">,
  kind: "arrival" | "departure",
  at: number,
  stops: readonly IrisStop[],
  toleranceMin = TOLERANCE_MIN,
): EventCheck {
  const key = trainKey(leg.tripNumber);
  const withEvent = stops.filter((stop) => stop[kind] !== null);
  const byNumber = key === null ? [] : withEvent.filter((stop) => trainKey(stop.number) === key);
  const line = leg.line === null ? null : foldStation(leg.line);
  const byLine =
    byNumber.length > 0 || line === null
      ? []
      : withEvent.filter((stop) => lineKeys(stop, stop[kind] as IrisEvent).includes(line));
  const candidates = byNumber.length > 0 ? byNumber : byLine;
  let best: { stop: IrisStop; delta: number } | null = null;
  for (const stop of candidates) {
    const delta = ((stop[kind] as IrisEvent).at - at) / MINUTE;
    if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { stop, delta };
  }
  if (best === null) return { status: "outside", deltaMin: null, train: null };
  const train = `${best.stop.category} ${best.stop.number}`;
  const deltaMin = Math.round(best.delta);
  if (byNumber.length === 0 && Math.abs(best.delta) > toleranceMin) {
    return { status: "outside", deltaMin: null, train: null };
  }
  return Math.abs(best.delta) <= toleranceMin
    ? { status: "within", deltaMin, train }
    : { status: "outside", deltaMin, train };
}

/** DB's direct trains from the origin's stops to the destination that leave inside the window. */
export function directTrains(
  stops: readonly IrisStop[],
  destinationNames: readonly string[],
  fromMs: number,
  toMs: number,
): IrisStop[] {
  const wanted = new Set(destinationNames.map(foldStation));
  const seen = new Set<string>();
  return stops.filter((stop) => {
    const departure = stop.departure;
    if (departure === null || departure.at < fromMs || departure.at > toMs) return false;
    if (!departure.path.some((name) => wanted.has(foldStation(name)))) return false;
    const id = `${stop.category} ${stop.number} ${departure.at}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

interface StadaStation {
  readonly name: string;
  readonly ifopt: string | null;
  readonly evas: readonly { readonly eva: number; readonly lon: number; readonly lat: number }[];
}

const DHID_BASE = /^([a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+?)(?:_G)*(?::|$)/;

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

export interface StationAt {
  readonly name: string;
  /** The station's EVAs, nearest to the stop first: DB lists a train under one of them (Berlin Hbf has three). */
  readonly evas: readonly number[];
}

/** Router legs DB Timetables cannot hold: city buses and city rail. DB lists only its rail replacement buses. */
const NOT_IN_IRIS = new Set(["bus", "urban"]);

export function checkableByIris(category: string): boolean {
  return !NOT_IN_IRIS.has(category);
}

/** The DB station of a router stop: StaDa by the stop's DHID, else the station with an EVA within 400 m; null abroad. */
export function stationOf(stop: LegStop, stations: readonly StadaStation[]): StationAt | null {
  const base = stop.stopId === null ? null : (DHID_BASE.exec(stop.stopId)?.[1] ?? null);
  const byDistance = (station: StadaStation) =>
    station.evas
      .map((entry) => ({ eva: entry.eva, m: metres(stop.lat, stop.lon, entry.lat, entry.lon) }))
      .sort((a, b) => a.m - b.m);
  const answer = (station: StadaStation) => ({
    name: station.name,
    evas: byDistance(station).map((entry) => entry.eva),
  });
  const byId = base === null ? undefined : stations.find((station) => station.ifopt === base);
  if (byId !== undefined && byId.evas.length > 0) return answer(byId);
  let near: { station: StadaStation; m: number } | null = null;
  for (const station of stations) {
    const nearest = byDistance(station)[0];
    if (nearest && nearest.m <= NEAR_STATION_M && (near === null || nearest.m < near.m)) {
      near = { station, m: nearest.m };
    }
  }
  return near === null ? null : answer(near.station);
}

function readStada(path: string): StadaStation[] {
  const body = JSON.parse(readFileSync(path, "utf8")) as {
    result: {
      name: string;
      ifopt?: string;
      evaNumbers: { number: number; geographicCoordinates?: { coordinates: [number, number] } }[];
    }[];
  };
  return body.result.map((station) => ({
    name: station.name,
    ifopt: station.ifopt ?? null,
    evas: station.evaNumbers.flatMap((entry) =>
      entry.geographicCoordinates
        ? [
            {
              eva: entry.number,
              lon: entry.geographicCoordinates.coordinates[0],
              lat: entry.geographicCoordinates.coordinates[1],
            },
          ]
        : [],
    ),
  }));
}

interface PairRow {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly time: string;
  readonly via?: string;
  readonly outcome: string;
  readonly askedTime?: string;
  readonly missing?: string;
  readonly journeyLegs?: readonly Journey[];
}

const sliceKey = (eva: number, at: number) => {
  const slice = sliceOf(at);
  return `${eva}/${slice.date}/${slice.hour}`;
};

class Cache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  get log(): string {
    return join(this.dir, "requests.jsonl");
  }

  file(key: string): string {
    return join(this.dir, `${key.replaceAll("/", "-")}.xml`);
  }

  has(key: string): boolean {
    return existsSync(this.file(key));
  }

  stops(key: string): IrisStop[] | null {
    return this.has(key) ? parseIrisPlan(readFileSync(this.file(key), "utf8")) : null;
  }

  /** Slices DB answered with anything but 200 in an earlier run, so a rerun does not ask again. */
  failed(): Set<string> {
    if (!existsSync(this.log)) return new Set();
    const lines = readFileSync(this.log, "utf8").split("\n").filter(Boolean);
    const entries = lines.map((line) => JSON.parse(line) as { slice: string; status: number });
    return new Set(entries.filter((entry) => entry.status !== 200).map((entry) => entry.slice));
  }

  requests(): number {
    return existsSync(this.log)
      ? readFileSync(this.log, "utf8").split("\n").filter(Boolean).length
      : 0;
  }
}

interface Context {
  readonly stations: readonly StadaStation[];
  readonly cache: Cache;
  readonly needs: Map<string, number>;
}

function want(context: Context, key: string, priority: number): IrisStop[] | null {
  const stops = context.cache.stops(key);
  if (stops === null)
    context.needs.set(key, Math.min(context.needs.get(key) ?? priority, priority));
  return stops;
}

/** The leg's slice, with the neighbouring hour when the time is within 10 minutes of it and the train is not on time. */
function checkAtEva(
  context: Context,
  leg: Leg,
  kind: "arrival" | "departure",
  eva: number,
  at: number,
  priority: number,
): EventCheck | null {
  const stops = want(context, sliceKey(eva, at), priority);
  if (stops === null) return null;
  const check = matchEvent(leg, kind, at, stops);
  const minute = new Date(at).getUTCMinutes();
  const edge = minute >= 50 ? at + HOUR : minute <= 9 ? at - HOUR : null;
  if (check.status === "within" || edge === null) return check;
  const more = want(context, sliceKey(eva, edge), Math.max(priority, 5));
  return more === null ? null : matchEvent(leg, kind, at, [...stops, ...more]);
}

/**
 * One end of a leg against DB's plan of its station: each EVA of the station in turn, nearest first, until the
 * train is within the tolerance; a train found off time is kept when no EVA has it on time.
 */
function checkEnd(
  context: Context,
  leg: Leg,
  kind: "arrival" | "departure",
  priority: number,
): EventCheck & { readonly station?: string } {
  if (!checkableByIris(leg.category)) {
    return { status: "not_checkable", reason: `${leg.category} legs are not in DB Timetables` };
  }
  const stop = kind === "departure" ? leg.from : leg.to;
  const station = stationOf(stop, context.stations);
  if (station === null) {
    return { status: "not_checkable", reason: `${stop.name} is not a DB station` };
  }
  const at = Date.parse(kind === "departure" ? leg.scheduledDeparture : leg.scheduledArrival);
  let best: EventCheck | null = null;
  for (const [index, eva] of station.evas.entries()) {
    const check = checkAtEva(context, leg, kind, eva, at, index === 0 ? priority : 6);
    if (check === null) return { status: "not_checkable", reason: "slice not fetched" };
    if (check.status === "within") return { ...check, station: station.name };
    if (best === null || (check.status === "outside" && check.train !== null)) best = check;
  }
  return { ...(best as EventCheck), station: station.name };
}

export interface PairResult {
  readonly pair: string;
  readonly kind: string;
  readonly result: "within" | "outside" | "not_enterable" | "no_answer";
  readonly reasons: readonly string[];
  readonly firstDeparture: string | null;
  readonly durationMin: number | null;
  readonly transfers: number | null;
  readonly checks: Record<string, unknown>;
}

const local = (at: number) => {
  const parts = partsOf(at);
  return `${parts.hour}:${parts.minute}`;
};

function legName(leg: Leg): string {
  return `${leg.category} ${leg.line ?? ""} ${leg.tripNumber ?? ""}`.replace(/\s+/g, " ").trim();
}

function outsideReason(leg: Leg, what: "departure" | "arrival", check: EventCheck): string | null {
  if (check.status !== "outside") return null;
  const stop = what === "departure" ? leg.from.name : leg.to.name;
  const time = local(
    Date.parse(what === "departure" ? leg.scheduledDeparture : leg.scheduledArrival),
  );
  if (check.train === null) {
    return `${legName(leg)} ${what} ${time} at ${stop}: no such train in DB's plan`;
  }
  const sign = (check.deltaMin ?? 0) > 0 ? "+" : "";
  return `${legName(leg)} ${what} ${time} at ${stop}: DB plans ${check.train} ${sign}${check.deltaMin} min`;
}

function checkLeg(context: Context, journey: Journey, leg: Leg, index: number, reasons: string[]) {
  const departure = checkEnd(context, leg, "departure", index === 0 ? 1 : 3);
  const arrival = checkEnd(context, leg, "arrival", index === journey.legs.length - 1 ? 2 : 3);
  for (const reason of [
    outsideReason(leg, "departure", departure),
    outsideReason(leg, "arrival", arrival),
  ]) {
    if (reason !== null) reasons.push(reason);
  }
  return { train: legName(leg), from: leg.from.name, to: leg.to.name, departure, arrival };
}

function transferOrder(journey: Journey): string[] {
  const reasons: string[] = [];
  for (let index = 1; index < journey.legs.length; index++) {
    const before = journey.legs[index - 1] as Leg;
    const after = journey.legs[index] as Leg;
    if (Date.parse(after.scheduledDeparture) < Date.parse(before.scheduledArrival)) {
      reasons.push(`transfer at ${after.from.name} leaves before the arrival`);
    }
  }
  return reasons;
}

interface DirectCheck {
  checked: boolean;
  trains: string[];
  missed: string[];
  unresolved: string[];
}

const trainAt = (stop: IrisStop) =>
  `${stop.category} ${stop.number} ${local((stop.departure as IrisEvent).at)}`;

function windowSlices(
  context: Context,
  eva: number,
  hours: readonly number[],
  priorityOf: (at: number) => number,
): { stops: IrisStop[]; complete: boolean } {
  const slices = hours.map((at) => want(context, sliceKey(eva, at), priorityOf(at)));
  return {
    stops: slices.flatMap((slice) => slice ?? []),
    complete: slices.every((slice) => slice !== null),
  };
}

/** The origin's stops in the window, from its nearest EVA, or the next one while DB lists nothing there. */
function originStopsInWindow(
  context: Context,
  evas: readonly number[],
  asked: number,
  windowEnd: number,
  firstDeparture: number,
): { stops: IrisStop[]; complete: boolean } {
  const hours: number[] = [];
  for (let at = asked - (asked % HOUR); at <= windowEnd; at += HOUR) hours.push(at);
  let found = { stops: [] as IrisStop[], complete: true };
  for (const [index, eva] of evas.entries()) {
    const priorityOf = (at: number) => (index > 0 ? 6 : at <= firstDeparture ? 1 : 4);
    found = windowSlices(context, eva, hours, priorityOf);
    if (found.stops.length > 0 || !found.complete) return found;
  }
  return found;
}

function earlierDirect(
  context: Context,
  stop: IrisStop,
  destination: StationAt | null,
  arrival: number,
  direct: DirectCheck,
  reasons: string[],
): void {
  const label = trainAt(stop);
  if (destination === null) {
    direct.unresolved.push(`${label} (destination not a DB station)`);
    return;
  }
  const there = destination.evas
    .flatMap((eva, index) =>
      [arrival - HOUR, arrival].flatMap(
        (at) => want(context, sliceKey(eva, at), index === 0 ? 5 : 6) ?? [],
      ),
    )
    .find((other) => trainKey(other.number) === trainKey(stop.number) && other.arrival !== null);
  if (there === undefined) direct.unresolved.push(label);
  else if ((there.arrival as IrisEvent).at <= arrival) {
    direct.missed.push(label);
    reasons.push(`DB plans ${label}, earlier and arriving by ${local(arrival)}, not in the answer`);
  }
}

/**
 * DB's direct trains from the origin in the answer's window: the answer must hold a direct journey when DB plans
 * one, and no direct train leaving before the first journey may arrive by its arrival.
 */
function checkDirect(
  context: Context,
  row: PairRow,
  ordered: readonly Journey[],
  reasons: string[],
): DirectCheck {
  const first = ordered[0] as Journey;
  const direct: DirectCheck = { checked: false, trains: [], missed: [], unresolved: [] };
  const origin = stationOf((first.legs[0] as Leg).from, context.stations);
  if (origin === null) return direct;
  const destinationStop = (first.legs.at(-1) as Leg).to;
  const destination = stationOf(destinationStop, context.stations);
  const asked = Date.parse(row.askedTime ?? first.departure);
  const lastDeparture = Date.parse((ordered.at(-1) as Journey).departure);
  const windowEnd = Math.min(lastDeparture, asked + DIRECT_WINDOW_HOURS * HOUR - MINUTE);
  const firstDeparture = Date.parse((first.legs[0] as Leg).scheduledDeparture);
  const window = originStopsInWindow(context, origin.evas, asked, windowEnd, firstDeparture);
  const names = [row.to, destinationStop.name, ...(destination ? [destination.name] : [])];
  const found = directTrains(window.stops, names, asked, windowEnd);
  direct.checked = window.complete;
  direct.trains = found.map(trainAt);
  if (window.complete && found.length > 0 && !ordered.some((journey) => journey.transfers === 0)) {
    reasons.push(
      `DB plans a direct train (${direct.trains[0]}) in the window, the answer has none`,
    );
  }
  for (const stop of found) {
    if ((stop.departure as IrisEvent).at < firstDeparture - TOLERANCE_MIN * MINUTE) {
      earlierDirect(context, stop, destination, Date.parse(first.arrival), direct, reasons);
    }
  }
  return direct;
}

function comparePair(context: Context, row: PairRow): PairResult {
  const pair = `${row.from} to ${row.to} ${row.time}`;
  const base = {
    pair,
    kind: row.kind,
    firstDeparture: null,
    durationMin: null,
    transfers: null,
    checks: {},
  };
  if (row.via !== "search") {
    return {
      ...base,
      result: "not_enterable",
      reasons: [
        row.missing
          ? `${row.missing} not found`
          : "a station is not found by the search with its name",
      ],
    };
  }
  const journeys = row.journeyLegs ?? [];
  if (row.outcome !== "answered" || journeys.length === 0) {
    return { ...base, result: "no_answer", reasons: [`router answer ${row.outcome}`] };
  }
  const ordered = [...journeys].sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure));
  const first = ordered[0] as Journey;
  const reasons: string[] = [];
  const legs = first.legs.map((leg, index) => checkLeg(context, first, leg, index, reasons));
  reasons.push(...transferOrder(first));
  const direct = checkDirect(context, row, ordered, reasons);
  return {
    ...base,
    result: reasons.length === 0 ? "within" : "outside",
    reasons,
    firstDeparture: local(Date.parse(first.departure)),
    durationMin: Math.round((Date.parse(first.arrival) - Date.parse(first.departure)) / MINUTE),
    transfers: first.transfers,
    checks: { legs, direct },
  };
}

function compareAll(rows: readonly PairRow[], context: Context): PairResult[] {
  return rows.map((row) => comparePair(context, row));
}

async function fetchSlice(
  cache: Cache,
  key: string,
  headers: Record<string, string>,
): Promise<number> {
  const response = await fetch(`${IRIS_PLAN}/${key}`, { headers });
  const body = await response.text();
  if (response.status === 200) writeFileSync(cache.file(key), body);
  appendFileSync(
    cache.log,
    `${JSON.stringify({ at: new Date().toISOString(), slice: key, status: response.status, bytes: body.length })}\n`,
  );
  return response.status;
}

function headersFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clientId = env.DB_CLIENT_ID?.trim();
  const apiKey = env.DB_API_KEY?.trim();
  if (!(clientId && apiKey)) throw new Error("DB_CLIENT_ID and DB_API_KEY must be set (K1)");
  return {
    "db-client-id": clientId,
    "db-api-key": apiKey,
    accept: "application/xml",
    "user-agent": userAgent({
      appName: env.APP_NAME?.trim() ?? "",
      version: "0.0.0",
      contact: env.APP_CONTACT ?? "",
    }),
  };
}

function counts(results: readonly PairResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const result of results) out[result.result] = (out[result.result] ?? 0) + 1;
  return out;
}

function writeTable(
  outPath: string,
  results: readonly PairResult[],
  needs: readonly (readonly [string, number])[],
  cache: Cache,
  sent: number,
): void {
  const summary = {
    counts: counts(results),
    requestsLogged: cache.requests(),
    sentThisRun: sent,
    slicesStillNeeded: needs.length,
    stillNeeded: needs.map(([key, priority]) => `${key} p${priority}`),
    neededByPriority: Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((p) => [p, needs.filter(([, q]) => q === p).length]),
    ),
  };
  writeFileSync(outPath, `${JSON.stringify({ summary, results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

interface FetchBudget {
  readonly headers: Record<string, string>;
  readonly max: number;
  readonly gapMs: number;
  sent: number;
  readonly failed: Set<string>;
}

/** Asks for the slices in priority order; a slice DB does not answer is left out, a 429 or 5xx ends the run. */
async function fetchNeeds(
  cache: Cache,
  needs: readonly string[],
  budget: FetchBudget,
): Promise<void> {
  for (const key of needs) {
    if (budget.sent >= budget.max) return;
    const status = await fetchSlice(cache, key, budget.headers);
    budget.sent++;
    process.stdout.write(`${status} ${key}\n`);
    if (status !== 200) budget.failed.add(key);
    if (status === 429 || status >= 500) {
      process.stderr.write(`stopping on HTTP ${status}\n`);
      budget.sent = budget.max;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, budget.gapMs));
  }
}

export interface Options {
  readonly fetch: boolean;
  readonly max: number;
  readonly gapMs: number;
  readonly until: string | null;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function parseOptions(argv: readonly string[]): Options {
  const fetch = argv.includes("--fetch");
  const gapMs = Number(valueAfter(argv, "--gap-ms") ?? REQUEST_GAP_MS);
  if (!Number.isInteger(gapMs) || gapMs < REQUEST_GAP_MS) {
    throw new Error(`--gap-ms must be a whole number of at least ${REQUEST_GAP_MS}`);
  }
  const until = valueAfter(argv, "--until") ?? null;
  if (until !== null && !/^\d{8}$/.test(until)) {
    throw new Error("--until must be a German local hour as YYMMDDHH");
  }
  return { fetch, max: fetch ? Number(valueAfter(argv, "--max") ?? 0) : 0, gapMs, until };
}

/** A plan slice key eva/YYMMDD/HH lies after the --until hour. */
export function beyondUntil(key: string, until: string | null): boolean {
  if (until === null) return false;
  const [, date, hour] = key.split("/");
  return date !== undefined && hour !== undefined && `${date}${hour}` > until;
}

async function main(argv: readonly string[]): Promise<void> {
  const [pairsPath, stadaPath, cacheDir, outPath] = argv;
  if (!(pairsPath && stadaPath && cacheDir && outPath)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const options = parseOptions(argv);
  const rows = (JSON.parse(readFileSync(pairsPath, "utf8")) as { rows: PairRow[] }).rows;
  const cache = new Cache(cacheDir);
  const stations = readStada(stadaPath);
  const budget: FetchBudget = {
    headers: options.fetch ? headersFromEnv(process.env) : {},
    max: options.max,
    gapMs: options.gapMs,
    sent: 0,
    failed: cache.failed(),
  };
  for (;;) {
    const context: Context = { stations, cache, needs: new Map() };
    const results = compareAll(rows, context);
    const pending = [...context.needs.entries()]
      .filter(([key]) => !budget.failed.has(key))
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const needs = pending.filter(([key]) => !beyondUntil(key, options.until));
    if (needs.length === 0 || budget.sent >= budget.max) {
      writeTable(outPath, results, pending, cache, budget.sent);
      return;
    }
    await fetchNeeds(
      cache,
      needs.map(([key]) => key),
      budget,
    );
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
