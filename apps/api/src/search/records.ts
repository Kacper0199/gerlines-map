import type { LegRun } from "@gerlines/schema/journeys";
import type { SearchLocale, SearchTrain } from "@gerlines/schema/search";

type LocalNames = Readonly<Record<SearchLocale, string>>;

/** A stop place of the active timetable: DELFI parent station, display name with its town. */
export interface StationRecord {
  readonly id: string;
  readonly name: string;
  /**
   * Names the station is found by but not shown with: the timetable name where the display
   * name differs ("Ostbahnhof" of München Ost), DB's and the EVA copy's names.
   */
  readonly otherNames?: readonly string[];
  readonly lon: number;
  readonly lat: number;
  readonly eva: number | null;
  /** DHID of the station. */
  readonly dhid: string | null;
  /**
   * The DELFI feed stop id journeys take: the DHID, else the station's own id in the feed,
   * which for most stations abroad fails the DHID form (`pl:unknown:EVANR-5100057`).
   */
  readonly stopId?: string | null;
  readonly lines: readonly string[];
  readonly trainsToday: number;
}

export type TrainRecord = Omit<SearchTrain, "kind">;

/** One line of one operator on the service day, with the box of its stops. */
export interface LineRecord {
  readonly id: string;
  readonly line: string;
  readonly productName: string | null;
  readonly category: SearchTrain["category"];
  readonly operator: string | null;
  readonly trainsToday: number;
  readonly bbox: readonly [number, number, number, number];
}

/** A Land (16) or a municipality (BKG VG250), with its names in the three languages. */
export interface PlaceRecord {
  readonly id: string;
  readonly type: "land" | "town";
  readonly names: LocalNames;
  readonly region: LocalNames | null;
  readonly landCode: string | null;
  readonly lon: number;
  readonly lat: number;
  readonly bbox: readonly [number, number, number, number] | null;
  /** 0 to 3: municipality, town, district-free city, Land. */
  readonly rank: number;
}

/** A DELFI GTFS stop id (from `id_map`) and the stop place it belongs to, for naming router stops. */
export interface StopIdRecord {
  readonly stopId: string;
  readonly stationId: string;
  /** The id is a `stop_point` key, so a row of the feed's stops.txt the router holds. */
  readonly stopPoint?: boolean;
  /** When a load last saw the id in `id_map` (epoch ms). */
  readonly seenMs?: number | null;
  /** Trip patterns that stop at the stop point (`trip_pattern_stop` rows) in the search's version. */
  readonly patterns?: number;
}

/** A timetable trip's run as the search index holds it, with the train number to confirm it by. */
export type TripRunMatch = LegRun & { readonly trainNumber: string | null };

/** One timetable trip of a service day and the train record of its run. */
export interface TripRunRecord {
  readonly serviceDate: string;
  readonly tripKey: string;
  readonly trainId: string;
}

export interface TimetableSearchData {
  readonly serviceDate: string;
  readonly timetableVersion: string;
  readonly stations: readonly StationRecord[];
  readonly stopIds?: readonly StopIdRecord[];
  readonly trains: readonly TrainRecord[];
  readonly tripRuns?: readonly TripRunRecord[];
  readonly lines: readonly LineRecord[];
}

export interface SearchData extends TimetableSearchData {
  readonly places: readonly PlaceRecord[];
}
