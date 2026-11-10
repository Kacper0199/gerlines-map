import type {
  SearchKind,
  SearchLocale,
  SearchResult,
  SearchStation,
} from "@gerlines/schema/search";
import { compactOf, foldText, tokensOf, wordsOf } from "./fold.ts";
import type {
  LineRecord,
  PlaceRecord,
  SearchData,
  StationRecord,
  StopIdRecord,
  TrainRecord,
  TripRunMatch,
} from "./records.ts";
import {
  mapSliced,
  nextTurn,
  type Pause,
  runNow,
  runSliced,
  SLICE_SIZE,
  type SlicedJob,
} from "./slices.ts";

interface Text {
  readonly full: string;
  readonly tokens: readonly string[];
  readonly compact: string;
}

interface Query extends Text {
  readonly digits: boolean;
}

export interface SearchOptions {
  readonly limit: number;
  readonly locale: SearchLocale;
  readonly nowMs?: number;
  readonly kinds?: readonly SearchKind[];
}

const MATCH = {
  exact: 100,
  partialPrefix: 80,
  wholeWords: 75,
  otherName: 72,
  compactPrefix: 70,
  words: 60,
  inside: 30,
} as const;
const PER_KIND_CAP: Readonly<Record<SearchKind, number>> = {
  station: 5,
  train: 5,
  line: 3,
  place: 3,
};
const LINE_WEIGHT = 6;
const NUMBER_EXACT = 950;
const NUMBER_PREFIX = 500;
const EVA_EXACT = 900;
const MIN_INSIDE_LENGTH = 3;
const SOON_MS = 2 * 3_600_000;
const RUNNING_BONUS = 40;
const SOON_BONUS = 25;
const LATER_BONUS = 10;
const PLACE_RANK_BONUS = 15;
const STATION_VOLUME = 30;
const MAIN_STATION_BONUS = 40;
const MIN_LETTERS = 2;
const CACHE_TTL_MS = 60_000;
const CACHE_SIZE = 500;

function textOf(value: string): Text {
  const full = foldText(value);
  return { full, tokens: tokensOf(value), compact: full.replaceAll(" ", "") };
}

function queryOf(value: string): Query | null {
  const full = foldText(value);
  const compact = full.replaceAll(" ", "");
  if (compact === "" || (!/\d/.test(compact) && compact.length < MIN_LETTERS)) return null;
  return { full, tokens: wordsOf(value), compact, digits: /^\d+$/.test(compact) };
}

function everyWordStarts(query: readonly string[], words: readonly string[]): boolean {
  const used = new Set<number>();
  for (const part of query) {
    const at = words.findIndex((word, i) => !used.has(i) && word.startsWith(part));
    if (at < 0) return false;
    used.add(at);
  }
  return true;
}

function wholeWords(query: readonly string[], words: readonly string[]): boolean {
  return query.every((part) => words.includes(part));
}

/**
 * How well one name answers the query, 0 when it does not. A typed whole word scores the same at
 * the start of a name as anywhere in it, so busy stations that name their town later still lead.
 */
function textScore(query: Query, text: Text): number {
  if (text.full === query.full || text.compact === query.compact) return MATCH.exact;
  if (wholeWords(query.tokens, text.tokens)) return MATCH.wholeWords;
  if (text.full.startsWith(query.full)) return MATCH.partialPrefix;
  if (text.compact.startsWith(query.compact)) return MATCH.compactPrefix;
  if (everyWordStarts(query.tokens, text.tokens)) return MATCH.words;
  if (query.full.length >= MIN_INSIDE_LENGTH && text.full.includes(query.full)) {
    return MATCH.inside;
  }
  return 0;
}

function best(query: Query, texts: readonly Text[]): number {
  let score = 0;
  for (const text of texts) score = Math.max(score, textScore(query, text));
  return score;
}

/**
 * A station matches by its shown name, or by a name it is not shown with (its timetable name, DB's
 * name) scored below a whole word of the shown name, so "Ostbahnhof" leads to Berlin Ostbahnhof
 * before München Ost and "Hauptbahnhof" pins no single town.
 */
function stationMatch(query: Query, station: IndexedStation): number {
  return Math.max(
    best(query, station.texts),
    Math.min(best(query, station.otherTexts), MATCH.otherName),
  );
}

function volumeBonus(count: number, weight: number): number {
  return Math.log10(count + 1) * weight;
}

interface Indexed<T> {
  readonly record: T;
  readonly texts: readonly Text[];
}

interface IndexedStation extends Indexed<StationRecord> {
  readonly otherTexts: readonly Text[];
  readonly eva: string | null;
  readonly main: number;
}

interface IndexedTrain extends Indexed<TrainRecord> {
  readonly order: string;
  readonly service: Text | null;
  readonly number: string | null;
  readonly line: Text | null;
  readonly departureMs: number;
  readonly arrivalMs: number;
}

interface IndexedLine extends Indexed<LineRecord> {
  readonly order: string;
}

interface Scored {
  readonly score: number;
  readonly order: string;
  readonly kind: SearchKind;
  readonly at: number;
}

export interface SearchIndexOptions {
  readonly cacheNow?: () => number;
}

export interface SearchIndexBuildOptions extends SearchIndexOptions {
  readonly pause?: Pause;
  readonly sliceSize?: number;
}

/** The prepared names of one day's records, made once when the index is built. */
interface PreparedRecords {
  readonly stations: readonly IndexedStation[];
  readonly trains: readonly IndexedTrain[];
  readonly lines: readonly IndexedLine[];
  readonly places: readonly Indexed<PlaceRecord>[];
}

function trainTexts(record: TrainRecord): {
  texts: Text[];
  service: Text | null;
  line: Text | null;
} {
  const line = record.line === null ? null : textOf(record.line);
  const title = textOf(record.title);
  const service =
    record.productName !== null && record.trainNumber !== null
      ? textOf(`${record.productName} ${record.trainNumber}`)
      : null;
  const texts = line !== null && title.compact === line.compact ? [] : [title];
  return { texts, service, line };
}

function numberMatch(query: Query, number: string | null): number {
  if (!query.digits || number === null) return 0;
  if (number === query.compact) return NUMBER_EXACT;
  return query.compact.length >= 3 && number.startsWith(query.compact) ? NUMBER_PREFIX : 0;
}

function trainMatch(query: Query, train: IndexedTrain): number {
  return Math.max(
    best(query, train.texts) * 10,
    train.service?.compact === query.compact ? MATCH.exact * 10 : 0,
    numberMatch(query, train.number),
    train.line === null ? 0 : textScore(query, train.line) * LINE_WEIGHT,
  );
}

function timeBonus(train: IndexedTrain, nowMs: number | undefined): number {
  if (nowMs === undefined) return 0;
  if (train.departureMs <= nowMs && nowMs <= train.arrivalMs) return RUNNING_BONUS;
  if (train.departureMs > nowMs) {
    return train.departureMs - nowMs <= SOON_MS ? SOON_BONUS : LATER_BONUS;
  }
  return 0;
}

function rowOrder(a: StopIdRecord, b: StopIdRecord): number {
  const seen = (b.seenMs ?? Number.NEGATIVE_INFINITY) - (a.seenMs ?? Number.NEGATIVE_INFINITY);
  if (seen !== 0) return seen;
  const patterns = (b.patterns ?? 0) - (a.patterns ?? 0);
  if (patterns !== 0) return patterns;
  return a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0;
}

/** Each station's stop point id the router most likely holds: seen latest, then in the most trip patterns. */
function rowsByStation(stopIds: readonly StopIdRecord[]): Map<string, string> {
  const best = new Map<string, StopIdRecord>();
  for (const record of stopIds) {
    if (record.stopPoint !== true) continue;
    const held = best.get(record.stationId);
    if (held === undefined || rowOrder(record, held) < 0) best.set(record.stationId, record);
  }
  return new Map([...best].map(([stationId, record]) => [stationId, record.stopId]));
}

const DHID_BASE = /^([a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+?)(?:_G)*(?::|$)/;

/** The station DHID of a DELFI stop id: `de:09162:100:22:22` and `de:09162:100_G` give `de:09162:100`. */
function dhidBase(stopId: string): string {
  return DHID_BASE.exec(stopId)?.[1] ?? stopId;
}

function stationAnswer({
  otherNames: _searchedOnly,
  stopId,
  ...record
}: StationRecord): SearchStation {
  return { kind: "station", ...record, stopId: stopId ?? record.dhid, lines: [...record.lines] };
}

function indexedStation(record: StationRecord): IndexedStation {
  return {
    record,
    texts: [textOf(record.name)],
    otherTexts: (record.otherNames ?? []).map(textOf),
    eva: record.eva === null ? null : String(record.eva),
    main: tokensOf(record.name).includes("hauptbahnhof") ? MAIN_STATION_BONUS : 0,
  };
}

function indexedTrain(record: TrainRecord): IndexedTrain {
  return {
    record,
    ...trainTexts(record),
    order: `${record.departure} ${record.id}`,
    number: record.trainNumber === null ? null : compactOf(record.trainNumber),
    departureMs: Date.parse(record.departure),
    arrivalMs: Date.parse(record.arrival),
  };
}

function indexedLine(record: LineRecord): IndexedLine {
  return { record, texts: [textOf(record.line)], order: `${record.line} ${record.operator ?? ""}` };
}

function indexedPlace(record: PlaceRecord): Indexed<PlaceRecord> {
  return { record, texts: [...new Set(Object.values(record.names))].map(textOf) };
}

function* preparing(data: SearchData, size = SLICE_SIZE): SlicedJob<PreparedRecords> {
  const stations = yield* mapSliced(data.stations, indexedStation, size);
  const trains = yield* mapSliced(data.trains, indexedTrain, size);
  const lines = yield* mapSliced(data.lines, indexedLine, size);
  const places = yield* mapSliced(data.places, indexedPlace, size);
  return { stations, trains, lines, places };
}

function tripRunKey(serviceDate: string, tripKey: string): string {
  return `${serviceDate}|${tripKey}`;
}

function runsByTrip(data: SearchData): Map<string, TripRunMatch> {
  const trains = new Map(data.trains.map((train) => [train.id, train]));
  const runs = new Map<string, TripRunMatch>();
  for (const { serviceDate, tripKey, trainId } of data.tripRuns ?? []) {
    const train = trains.get(trainId);
    if (!train) continue;
    runs.set(tripRunKey(serviceDate, tripKey), {
      tripInstanceId: train.id,
      departure: train.departure,
      arrival: train.arrival,
      trainNumber: train.trainNumber,
    });
  }
  return runs;
}

/**
 * The in-memory search over one service day: stations, trains and lines of the active timetable
 * and the places of the geo base. Every query scans the prepared names (about 60,000), which takes
 * a few milliseconds and needs no database index; only the results shown are built, and a repeated
 * query is answered from a small cache for a minute.
 */
export class SearchIndex {
  readonly serviceDate: string;
  readonly timetableVersion: string;
  private readonly stations: readonly IndexedStation[];
  private readonly stationsById: ReadonlyMap<string, StationRecord>;
  private readonly stationIdsByStopId: ReadonlyMap<string, string>;
  private readonly rowsByStation: ReadonlyMap<string, string>;
  private readonly trains: readonly IndexedTrain[];
  private readonly runsByTrip: ReadonlyMap<string, TripRunMatch>;
  private readonly lines: readonly IndexedLine[];
  private readonly places: readonly Indexed<PlaceRecord>[];
  private readonly cacheNow: () => number;
  private readonly cache = new Map<string, { at: number; results: SearchResult[] }>();

  private constructor(
    data: SearchData,
    { cacheNow = Date.now }: SearchIndexOptions,
    prepared: PreparedRecords,
  ) {
    this.cacheNow = cacheNow;
    this.serviceDate = data.serviceDate;
    this.timetableVersion = data.timetableVersion;
    this.stations = prepared.stations;
    this.stationsById = new Map(data.stations.map((record) => [record.id, record]));
    this.stationIdsByStopId = new Map([
      ...data.stations.flatMap((record) =>
        record.dhid === null ? [] : [[record.dhid, record.id] as const],
      ),
      ...(data.stopIds ?? []).map(({ stopId, stationId }) => [stopId, stationId] as const),
    ]);
    this.rowsByStation = rowsByStation(data.stopIds ?? []);
    this.trains = prepared.trains;
    this.runsByTrip = runsByTrip(data);
    this.lines = prepared.lines;
    this.places = prepared.places;
  }

  /** The index built at once. */
  static of(data: SearchData, options: SearchIndexOptions = {}): SearchIndex {
    return new SearchIndex(data, options, runNow(preparing(data)));
  }

  /**
   * The index built in slices with a pause after each, so the event loop keeps answering requests
   * while a new day or timetable version is prepared.
   */
  static async build(
    data: SearchData,
    { pause = nextTurn, sliceSize = SLICE_SIZE, ...options }: SearchIndexBuildOptions = {},
  ): Promise<SearchIndex> {
    const prepared = await runSliced(preparing(data, sliceSize), pause);
    await pause();
    return new SearchIndex(data, options, prepared);
  }

  /** One station of the index by its stop place id, for a link that names it. */
  station(id: string): SearchStation | null {
    const found = this.stationsById.get(id);
    return found ? stationAnswer(found) : null;
  }

  /**
   * The display name of the station a DELFI stop id belongs to (a platform such as
   * `de:11000:900003200:2:53` of Berlin Hbf), through `id_map` or the DHID of the station; null when
   * the stop is not a station of this index.
   */
  stationNameOfStop(stopId: string): string | null {
    const id = this.stationIdsByStopId.get(stopId) ?? this.stationIdsByStopId.get(dhidBase(stopId));
    return (id === undefined ? undefined : this.stationsById.get(id)?.name) ?? null;
  }

  /**
   * A stops.txt row of the station a stop id belongs to, for a router that does not hold the id:
   * the importer builds a station from platform ids alone when stops.txt has no row for
   * it, and MOTIS knows only the rows. Null when the station has no other row.
   */
  routableStopOf(stopId: string): string | null {
    const id = this.stationIdsByStopId.get(stopId) ?? this.stationIdsByStopId.get(dhidBase(stopId));
    const row = id === undefined ? undefined : this.rowsByStation.get(id);
    return row === undefined || row === stopId ? null : row;
  }

  /** The run of the train a timetable trip of a service day belongs to, for a journey leg. */
  runOfTrip(serviceDate: string, tripKey: string): TripRunMatch | null {
    return this.runsByTrip.get(tripRunKey(serviceDate, tripKey)) ?? null;
  }

  get size(): number {
    return this.stations.length + this.trains.length + this.lines.length + this.places.length;
  }

  search(text: string, options: SearchOptions): SearchResult[] {
    const key = [
      options.locale,
      options.limit,
      options.kinds ? [...options.kinds].sort().join(",") : "",
      text,
    ].join("\u0000");
    const at = this.cacheNow();
    const held = this.cache.get(key);
    this.cache.delete(key);
    if (held && at - held.at < CACHE_TTL_MS) {
      this.cache.set(key, held);
      return held.results;
    }
    const results = this.rank(text, options);
    this.cache.set(key, { at, results });
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return results;
  }

  private rank(text: string, options: SearchOptions): SearchResult[] {
    const query = queryOf(text);
    if (query === null) return [];
    const kinds = new Set<SearchKind>(options.kinds ?? ["station", "train", "line", "place"]);
    const scored: Scored[] = [];
    if (kinds.has("station")) this.scoreStations(query, scored);
    if (kinds.has("train")) this.scoreTrains(query, options.nowMs, scored);
    if (kinds.has("line")) this.scoreLines(query, scored);
    if (kinds.has("place")) this.scorePlaces(query, options.locale, scored);
    scored.sort(
      (a, b) => b.score - a.score || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0),
    );
    const capped = kinds.size > 1;
    const taken = new Map<SearchKind, number>();
    const results: SearchResult[] = [];
    for (const entry of scored) {
      if (results.length >= options.limit) break;
      const count = taken.get(entry.kind) ?? 0;
      if (capped && count >= PER_KIND_CAP[entry.kind]) continue;
      taken.set(entry.kind, count + 1);
      results.push(this.result(entry, options.locale));
    }
    return results;
  }

  private result({ kind, at }: Scored, locale: SearchLocale): SearchResult {
    switch (kind) {
      case "station": {
        return stationAnswer((this.stations[at] as IndexedStation).record);
      }
      case "train":
        return { kind: "train", ...(this.trains[at] as IndexedTrain).record };
      case "line": {
        const { record } = this.lines[at] as IndexedLine;
        return { kind: "line", ...record, bbox: [...record.bbox] };
      }
      case "place": {
        const { record } = this.places[at] as Indexed<PlaceRecord>;
        return {
          kind: "place",
          id: record.id,
          type: record.type,
          name: record.names[locale],
          region: record.region?.[locale] ?? null,
          landCode: record.landCode,
          lon: record.lon,
          lat: record.lat,
          bbox: record.bbox === null ? null : [...record.bbox],
        };
      }
    }
  }

  private scoreStations(query: Query, out: Scored[]): void {
    this.stations.forEach((station, at) => {
      const match =
        query.digits && station.eva === query.compact
          ? EVA_EXACT
          : stationMatch(query, station) * 10;
      if (match === 0) return;
      const { record } = station;
      out.push({
        score: match + volumeBonus(record.trainsToday, STATION_VOLUME) + station.main,
        order: record.name,
        kind: "station",
        at,
      });
    });
  }

  private scoreTrains(query: Query, nowMs: number | undefined, out: Scored[]): void {
    this.trains.forEach((train, at) => {
      const match = trainMatch(query, train);
      if (match === 0) return;
      out.push({ score: match + timeBonus(train, nowMs), order: train.order, kind: "train", at });
    });
  }

  private scoreLines(query: Query, out: Scored[]): void {
    this.lines.forEach((line, at) => {
      const match = best(query, line.texts) * 10;
      if (match === 0) return;
      out.push({
        score: match + volumeBonus(line.record.trainsToday, 10),
        order: line.order,
        kind: "line",
        at,
      });
    });
  }

  private scorePlaces(query: Query, locale: SearchLocale, out: Scored[]): void {
    this.places.forEach((place, at) => {
      const match = best(query, place.texts) * 10;
      if (match === 0) return;
      const { record } = place;
      out.push({
        score: match + record.rank * PLACE_RANK_BONUS,
        order: record.names[locale],
        kind: "place",
        at,
      });
    });
  }
}
