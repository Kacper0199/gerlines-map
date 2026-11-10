import type {
  TrainCategory,
  TrainDetail,
  TrainPhoto,
  TrainStop,
  VehicleIdentity,
} from "@gerlines/schema";

import type { CategoryKey } from "@gerlines/ui";
import { type ProfileCardSubject, profileSubjectOf } from "../../profile/subject.ts";
import { type ForecastModel, forecastModel } from "./forecast/forecast-model.ts";

export const STALE_AFTER_MS = 3 * 60_000;

const BERLIN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DAY_MS = 86_400_000;

const LONG_DISTANCE: ReadonlySet<TrainCategory> = new Set(["hsr", "ld", "night"]);
const NAMED_CATEGORIES: ReadonlySet<TrainCategory> = new Set([
  "hsr",
  "ld",
  "night",
  "rfast",
  "reg",
  "sbahn",
]);

export type StopRole = "passed" | "next" | "ahead";

export interface StopTimes {
  readonly predictedMs: number | null;
  readonly scheduledMs: number | null;
}

export interface MainTime extends StopTimes {
  readonly kind: "arrival" | "departure";
}

export interface Platform {
  readonly track: string;
  readonly was: string | null;
}

export interface StopRow {
  readonly index: number;
  readonly stopPlaceId: string;
  readonly name: string;
  readonly role: StopRole;
  readonly cancelled: boolean;
  readonly arrival: StopTimes;
  readonly departure: StopTimes;
  readonly main: MainTime;
  readonly delayMinutes: number | null;
  readonly arrivalDelayMinutes: number | null;
  readonly departureDelayMinutes: number | null;
  readonly platform: Platform | null;
  readonly dayOffset: number;
}

export type Position =
  | { readonly kind: "cancelled" }
  | { readonly kind: "before"; readonly stop: StopRow; readonly next: StopRow | null }
  | {
      readonly kind: "between";
      readonly from: StopRow;
      readonly to: StopRow;
      readonly progress: number;
      readonly arrivalMs: number;
    }
  | { readonly kind: "at"; readonly stop: StopRow; readonly next: StopRow | null }
  | { readonly kind: "arrived"; readonly stop: StopRow; readonly from: StopRow | null };

export type ShortRun =
  | { readonly kind: "ends-early"; readonly stop: StopRow; readonly cancelled: number }
  | { readonly kind: "skips"; readonly cancelled: number };

export type BadgeKind = "named" | "bus" | "urban" | "train";

export interface Freshness {
  readonly fetchAgeMs: number;
  readonly refreshError: string | null;
  readonly notDrawn?: boolean;
}

const FRESH: Freshness = { fetchAgeMs: 0, refreshError: null };

export interface Subtitle {
  readonly kind: "line" | "number";
  readonly value: string;
}

/** How the card words the title: as it is, as a line (Line 527) or as a train number (Train 541). */
export type TitleKind = "plain" | "line" | "number";

export interface TrainCardModel {
  readonly id: string;
  readonly category: CategoryKey;
  readonly badge: BadgeKind;
  readonly title: string | null;
  readonly titleKind: TitleKind;
  readonly subtitle: Subtitle | null;
  readonly origin: string;
  readonly destination: string;
  /** What a headsign adds to the last stop's name: the text in its brackets, such as a diversion. */
  readonly destinationNote: string | null;
  readonly operator: string | null;
  readonly delayMinutes: number | null;
  /** The delay is the live tick's current one, since the next stop has no prediction; not on time. */
  readonly delayNow: boolean;
  readonly realtime: boolean;
  readonly cancelled: boolean;
  readonly added: boolean;
  readonly onMap: boolean;
  /** The map does not draw this train (no frame for it yet), whatever its geometry says. */
  readonly notDrawn: boolean;
  readonly noGeometry: boolean;
  readonly stops: readonly StopRow[];
  readonly position: Position;
  readonly shortRun: ShortRun | null;
  readonly lastServedIndex: number | null;
  readonly dataTimeMs: number;
  readonly stale: boolean;
  readonly refreshFailed: boolean;
  readonly source: { readonly kind: "realtime" | "timetable"; readonly attribution: string };
  readonly vehicle: VehicleIdentity | null;
  readonly photo: TrainPhoto | null;
  readonly forecast: ForecastModel | null;
  /** Whose segment profile the card can show, null when the map does not draw the train. */
  readonly profile: ProfileCardSubject | null;
}

function ms(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

export function roundMinutes(seconds: number): number {
  const minutes = Math.round(Math.abs(seconds) / 60);
  return seconds < 0 && minutes > 0 ? -minutes : minutes;
}

function badgeOf(detail: TrainDetail): BadgeKind {
  if (detail.foreign || NAMED_CATEGORIES.has(detail.category)) {
    return "named";
  }
  return detail.category === "bus" || detail.category === "urban" ? detail.category : "train";
}

function berlinDay(msValue: number): number {
  return Math.round(Date.parse(BERLIN_DATE.format(msValue)) / DAY_MS);
}

function cardCategory(detail: TrainDetail): CategoryKey {
  if (detail.foreign) {
    return "foreign";
  }
  return NAMED_CATEGORIES.has(detail.category) ? (detail.category as CategoryKey) : "reg";
}

const DIGITS_ONLY = /^\d+$/;

function titleKindOf(title: string | null, line: string | null): TitleKind {
  if (title === null || !DIGITS_ONLY.test(title)) {
    return "plain";
  }
  return title === line ? "line" : "number";
}

/**
 * Long distance trains: product and number (ICE 597) with the line below; without a number the
 * line as written (FLX10), and the product only when there is no line either.
 */
function longDistanceNaming(
  detail: TrainDetail,
  parts: { product: string | null; line: string | null; productAndNumber: string | null },
): { title: string | null; titleKind: TitleKind; subtitle: Subtitle | null } {
  const { product, line, productAndNumber } = parts;
  if (detail.trainNumber === null) {
    const title = detail.line ?? product;
    return { title, titleKind: titleKindOf(title, detail.line), subtitle: null };
  }
  const title = productAndNumber ?? detail.trainNumber;
  return {
    title,
    titleKind: titleKindOf(title, line),
    subtitle: line !== null && title !== line ? { kind: "line", value: line } : null,
  };
}

function naming(detail: TrainDetail): {
  title: string | null;
  titleKind: TitleKind;
  subtitle: Subtitle | null;
} {
  const number = detail.trainNumber;
  const alphabeticLine = detail.line !== null && /^[A-Za-z]+$/.test(detail.line);
  const product = detail.productName ?? (alphabeticLine ? detail.line : null);
  const line = detail.line !== null && detail.line !== product ? detail.line : null;
  const productAndNumber = product !== null && number !== null ? `${product} ${number}` : null;
  if (LONG_DISTANCE.has(detail.category)) {
    return longDistanceNaming(detail, { product, line, productAndNumber });
  }
  const title = line ?? productAndNumber ?? product ?? number;
  const showNumber = number !== null && title !== null && !title.includes(number);
  return {
    title,
    titleKind: titleKindOf(title, line),
    subtitle: showNumber ? { kind: "number", value: number } : null,
  };
}

const BRACKETED = /\(([^()]+)\)\s*$/;

/**
 * A headsign is a local name (Hauptbahnhof, Altona) and misleads on a national map, so the card
 * names the last stop. What a headsign adds is the note in brackets at its end, for example
 * (Umleitung) on a diverted train.
 */
function namesOperator(note: string, operator: TrainDetail["operator"]): boolean {
  if (operator === null) return false;
  const wanted = note.toLowerCase();
  const name = operator.name.toLowerCase();
  return name === wanted || name.startsWith(`${wanted} `) || operator.id.toLowerCase() === wanted;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function carriesWord(text: string, word: string): boolean {
  return new RegExp(`(^|[\\s(,-])${escapeRegExp(word)}($|[\\s),-])`, "i").test(text);
}

function headsignNote(
  headsign: string | null,
  destination: string,
  operator: TrainDetail["operator"],
): string | null {
  const note = headsign === null ? null : (BRACKETED.exec(headsign)?.[1]?.trim() ?? null);
  if (note === null) return null;
  return carriesWord(destination, note) || namesOperator(note, operator) ? null : note;
}

function platformOf(stop: TrainStop): Platform | null {
  const { platformActual: actual, platformScheduled: scheduled } = stop;
  const track = actual ?? scheduled;
  if (track === null) {
    return null;
  }
  return {
    track,
    was: actual !== null && scheduled !== null && actual !== scheduled ? scheduled : null,
  };
}

function minutesOf(seconds: number | null, realtime: boolean): number | null {
  return realtime && seconds !== null ? roundMinutes(seconds) : null;
}

function stopRow(stop: TrainStop, role: StopRole, isFirst: boolean, realtime: boolean): StopRow {
  const arrival = {
    predictedMs: realtime ? ms(stop.predictedArrival) : null,
    scheduledMs: ms(stop.scheduledArrival),
  };
  const departure = {
    predictedMs: realtime ? ms(stop.predictedDeparture) : null,
    scheduledMs: ms(stop.scheduledDeparture),
  };
  const hasArrival = arrival.scheduledMs !== null || arrival.predictedMs !== null;
  const hasDeparture = departure.scheduledMs !== null || departure.predictedMs !== null;
  const useDeparture = isFirst || !hasArrival || (role === "passed" && hasDeparture);
  const main: MainTime = useDeparture
    ? { kind: "departure", ...departure }
    : { kind: "arrival", ...arrival };
  const arrivalDelayMinutes = minutesOf(stop.arrivalDelaySeconds, realtime);
  const departureDelayMinutes = minutesOf(stop.departureDelaySeconds, realtime);
  return {
    index: stop.index,
    stopPlaceId: stop.stopPlaceId,
    name: stop.name,
    role,
    cancelled: stop.cancelled,
    arrival,
    departure,
    main,
    delayMinutes: useDeparture ? departureDelayMinutes : arrivalDelayMinutes,
    arrivalDelayMinutes,
    departureDelayMinutes,
    platform: platformOf(stop),
    dayOffset: 0,
  };
}

function withDays(stops: readonly StopRow[]): StopRow[] {
  const first = stops.map((stop) => timeOf(stop.main)).find((value) => value !== null);
  if (first === undefined) {
    return [...stops];
  }
  const start = berlinDay(first);
  return stops.map((stop) => {
    const shown = timeOf(stop.main);
    return shown === null ? stop : { ...stop, dayOffset: berlinDay(shown) - start };
  });
}

export function timeOf(times: StopTimes): number | null {
  return times.predictedMs ?? times.scheduledMs;
}

function departureMs(stop: StopRow): number | null {
  return timeOf(stop.departure) ?? timeOf(stop.arrival);
}

function arrivalMs(stop: StopRow): number | null {
  return timeOf(stop.arrival) ?? timeOf(stop.departure);
}

function rolesOf(detail: TrainDetail, nextIndex: number | null): (stop: TrainStop) => StopRole {
  const { lastPassedIndex } = detail.progress;
  return (stop) => {
    if (lastPassedIndex !== null && stop.index <= lastPassedIndex) {
      return "passed";
    }
    if (nextIndex === null && lastPassedIndex !== null) {
      return "passed";
    }
    return stop.index === nextIndex ? "next" : "ahead";
  };
}

function nextServedIndex(detail: TrainDetail): number | null {
  const { lastPassedIndex, nextIndex } = detail.progress;
  const from = nextIndex ?? (lastPassedIndex === null ? 0 : null);
  if (from === null) {
    return null;
  }
  return detail.stops.find((stop) => stop.index >= from && !stop.cancelled)?.index ?? null;
}

function servedAfter(served: readonly StopRow[], stop: StopRow): StopRow | null {
  return served.find((candidate) => candidate.index > stop.index) ?? null;
}

function servedBefore(served: readonly StopRow[], stop: StopRow): StopRow | null {
  return [...served].reverse().find((candidate) => candidate.index < stop.index) ?? null;
}

function arrived(served: readonly StopRow[], stops: readonly StopRow[]): Position {
  const last = served[served.length - 1] ?? stops[stops.length - 1];
  return last
    ? { kind: "arrived", stop: last, from: servedBefore(served, last) }
    : { kind: "cancelled" };
}

function onTheWay(from: StopRow, next: StopRow, nowMs: number, lastPassedIndex: number): Position {
  const departure = departureMs(from);
  if (from.index === lastPassedIndex && departure !== null && nowMs < departure) {
    return { kind: "at", stop: from, next };
  }
  const arrival = arrivalMs(next);
  const span = arrival !== null && departure !== null ? arrival - departure : 0;
  const progress = span > 0 && departure !== null ? (nowMs - departure) / span : 0;
  return {
    kind: "between",
    from,
    to: next,
    progress: Math.min(1, Math.max(0, progress)),
    arrivalMs: arrival ?? nowMs,
  };
}

function position(detail: TrainDetail, stops: readonly StopRow[], nowMs: number): Position {
  if (detail.cancelled) {
    return { kind: "cancelled" };
  }
  const served = stops.filter((stop) => !stop.cancelled);
  const next = served.find((stop) => stop.role === "next") ?? null;
  if (next === null) {
    return arrived(served, stops);
  }
  const from = servedBefore(served, next);
  const { lastPassedIndex } = detail.progress;
  return lastPassedIndex !== null && from !== null
    ? onTheWay(from, next, nowMs, lastPassedIndex)
    : { kind: "before", stop: next, next: servedAfter(served, next) };
}

function shortRunOf(detail: TrainDetail, stops: readonly StopRow[]): ShortRun | null {
  if (detail.cancelled) {
    return null;
  }
  const cancelled = stops.filter((stop) => stop.cancelled && stop.role !== "passed").length;
  if (cancelled === 0) {
    return null;
  }
  const lastServed = [...stops].reverse().find((stop) => !stop.cancelled);
  const last = stops[stops.length - 1];
  return lastServed && last?.cancelled
    ? { kind: "ends-early", stop: lastServed, cancelled }
    : { kind: "skips", cancelled };
}

function feedAgeMs(detail: TrainDetail): number {
  const observed = ms(detail.provenance.feedObservedAt);
  return observed === null ? 0 : Date.parse(detail.asOf) - observed;
}

export function buildCardModel(
  detail: TrainDetail,
  nowMs: number,
  freshness: Freshness = FRESH,
): TrainCardModel {
  const realtime = detail.provenance.kind === "realtime";
  const roleOf = rolesOf(detail, detail.cancelled ? null : nextServedIndex(detail));
  const stops = withDays(
    detail.stops.map((stop, i) =>
      stopRow(stop, detail.cancelled ? "ahead" : roleOf(stop), i === 0, realtime),
    ),
  );
  const dataTimeMs = ms(detail.provenance.feedObservedAt) ?? Date.parse(detail.asOf);
  const { title, titleKind, subtitle } = naming(detail);
  const shortRun = shortRunOf(detail, stops);
  const onMap = !detail.cancelled && detail.geometry.available && freshness.notDrawn !== true;
  return {
    id: detail.tripInstanceId,
    category: cardCategory(detail),
    badge: badgeOf(detail),
    title,
    titleKind,
    subtitle,
    origin: detail.stops[0]?.name ?? detail.destination.name,
    destination: detail.destination.name,
    destinationNote: headsignNote(detail.headsign, detail.destination.name, detail.operator),
    operator: detail.operator?.name ?? null,
    delayMinutes:
      realtime && detail.delaySeconds !== null ? roundMinutes(detail.delaySeconds) : null,
    delayNow:
      realtime &&
      detail.delaySeconds !== null &&
      roundMinutes(detail.delaySeconds) !== 0 &&
      detail.delayBasis === "current",
    realtime,
    cancelled: detail.cancelled,
    added: detail.added,
    onMap,
    notDrawn: freshness.notDrawn === true,
    noGeometry: !detail.geometry.available,
    stops,
    position: position(detail, stops, nowMs),
    shortRun,
    lastServedIndex: shortRun?.kind === "ends-early" ? shortRun.stop.index : null,
    dataTimeMs,
    stale: feedAgeMs(detail) > STALE_AFTER_MS || freshness.fetchAgeMs > STALE_AFTER_MS,
    refreshFailed: freshness.refreshError !== null,
    source: { kind: detail.provenance.kind, attribution: detail.provenance.attribution },
    vehicle: detail.vehicle,
    photo: detail.photo,
    forecast: forecastModel(detail),
    profile: profileSubjectOf(detail, onMap),
  };
}
