import {
  SEARCH_LOCALES,
  type SearchKind,
  SearchLine,
  SearchPlace,
  SearchStation,
  SearchTrain,
  STOP_ID_PATTERN,
} from "@gerlines/schema/search";
import type { PlaceRecord, SearchData, StationRecord } from "./records.ts";
import { filterSliced, runNow, SLICE_SIZE, type SlicedJob } from "./slices.ts";

function withValidStopId(record: StationRecord): StationRecord {
  return record.stopId == null || STOP_ID_PATTERN.test(record.stopId)
    ? record
    : { ...record, stopId: null };
}

function placeValid(record: PlaceRecord): boolean {
  return SEARCH_LOCALES.every(
    (locale) =>
      SearchPlace.safeParse({
        kind: "place",
        id: record.id,
        type: record.type,
        name: record.names[locale],
        region: record.region?.[locale] ?? null,
        landCode: record.landCode,
        lon: record.lon,
        lat: record.lat,
        bbox: record.bbox,
      }).success,
  );
}

export interface ValidRecords {
  readonly data: SearchData;
  readonly dropped: Record<SearchKind, number>;
}

/**
 * The records an index may hold: each one as an answer meets the shared contract, since the web
 * client refuses a whole answer when one result breaks it. Dropped records are counted per kind; a
 * station whose feed stop id breaks the contract stays, without a stop id journeys could take.
 */
export function validRecords(data: SearchData): ValidRecords {
  return runNow(validating(data));
}

/** `validRecords` as a sliced job of `size` records a slice. */
export function* validating(data: SearchData, size = SLICE_SIZE): SlicedJob<ValidRecords> {
  const stations = yield* filterSliced(
    data.stations.map(withValidStopId),
    (record) => SearchStation.safeParse({ kind: "station", ...record }).success,
    size,
  );
  const trains = yield* filterSliced(
    data.trains,
    (record) => SearchTrain.safeParse({ kind: "train", ...record }).success,
    size,
  );
  const lines = yield* filterSliced(
    data.lines,
    (record) => SearchLine.safeParse({ kind: "line", ...record }).success,
    size,
  );
  const places = yield* filterSliced(data.places, placeValid, size);
  return {
    data: { ...data, stations, trains, lines, places },
    dropped: {
      station: data.stations.length - stations.length,
      train: data.trains.length - trains.length,
      line: data.lines.length - lines.length,
      place: data.places.length - places.length,
    },
  };
}
