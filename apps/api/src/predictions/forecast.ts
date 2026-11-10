import type { ForecastStop, TrainDetail, TrainForecast, TrainStop } from "@gerlines/schema";
import type { PredictionTable, Quantiles } from "./table.ts";

const UPPER_QUANTILE = 0.8;
const TRAIN_NUMBER = /^\d{1,9}$/;

/** The EVA number of a stop place, or null when the timetable has none. */
export type EvaOf = (stopPlaceId: string) => number | null;

function wholeMinutes(seconds: number): number {
  return Math.floor(seconds / 60);
}

interface Start {
  readonly position: number;
  readonly fromIndex: number;
  readonly fromDelayMinutes: number;
  readonly trainNumber: number;
}

function startOf(detail: TrainDetail): Start | null {
  const fromIndex = detail.progress.lastPassedIndex;
  const trainNumber = detail.trainNumber;
  if (fromIndex === null || trainNumber === null || !TRAIN_NUMBER.test(trainNumber)) return null;
  const position = detail.stops.findIndex((stop) => stop.index === fromIndex);
  const from = detail.stops[position];
  if (!from || from.cancelled) return null;
  const delaySeconds = from.departureDelaySeconds ?? from.arrivalDelaySeconds;
  if (delaySeconds === null) return null;
  return {
    position,
    fromIndex,
    fromDelayMinutes: wholeMinutes(delaySeconds),
    trainNumber: Number(trainNumber),
  };
}

/** The feed's predicted arrival delay at a stop in whole minutes, or null when it sent none. */
function feedDelayMinutes(detail: TrainDetail, stop: TrainStop): number | null {
  if (detail.provenance.kind !== "realtime") return null;
  if (stop.predictedArrival === null || stop.arrivalDelaySeconds === null) return null;
  return wholeMinutes(stop.arrivalDelaySeconds);
}

function valuesOf(
  found: Quantiles,
  base: number,
  feed: number | null,
): Pick<ForecastStop, "expectedDelayMinutes" | "upperDelayMinutes" | "basis"> {
  if (feed === null) {
    return {
      expectedDelayMinutes: base + found.median,
      upperDelayMinutes: base + found.p80,
      basis: "b1",
    };
  }
  return {
    expectedDelayMinutes: feed,
    upperDelayMinutes: feed + found.p80 - found.median,
    basis: "feed_plus_spread",
  };
}

function stopsAheadOf(
  detail: TrainDetail,
  start: Start,
  table: PredictionTable,
  evaOf: EvaOf,
): ForecastStop[] {
  const band = table.band(start.fromDelayMinutes);
  const base = table.meta.variant === "change" ? start.fromDelayMinutes : 0;
  const stops: ForecastStop[] = [];
  let stopsAhead = 0;
  for (const stop of detail.stops.slice(start.position + 1)) {
    if (stop.cancelled) continue;
    stopsAhead += 1;
    if (stopsAhead > table.meta.maxAhead) break;
    const eva =
      stop.scheduledArrival !== null && table.ships(stopsAhead) ? evaOf(stop.stopPlaceId) : null;
    const found =
      eva === null
        ? null
        : table.lookup({
            category: detail.category,
            trainNumber: start.trainNumber,
            eva,
            band,
            horizon: table.horizon(stopsAhead),
          });
    if (!found) continue;
    stops.push({
      index: stop.index,
      stopsAhead,
      ...valuesOf(found, base, feedDelayMinutes(detail, stop)),
      level: found.level,
      runs: found.runs,
    });
  }
  return stops;
}

/**
 * The forecast for the stops ahead of a running train (WP-7.5, D-065): B1's quantiles from the
 * delay measured at its last passed stop (departure, else arrival, in whole minutes rounded down as
 * IRIS gives them), for each later stop that is not cancelled, has a planned arrival and an EVA
 * number, at a horizon where B1 shipped. Where the realtime feed predicts the stop's arrival, the
 * expected delay is the feed's, rounded down to whole minutes, and the upper bound adds B1's spread
 * (p80 minus median) to it; elsewhere both are B1's. Null when the train has passed no stop, has no
 * delay there, no numeric train number, a category the table does not know, or no stop qualifies.
 */
export function forecastOf(
  detail: TrainDetail,
  table: PredictionTable,
  evaOf: EvaOf,
): TrainForecast | null {
  const start = startOf(detail);
  if (!start) return null;
  const stops = stopsAheadOf(detail, start, table, evaOf);
  if (stops.length === 0) return null;
  const { meta } = table;
  return {
    method: meta.method,
    fromIndex: start.fromIndex,
    fromDelayMinutes: start.fromDelayMinutes,
    upperQuantile: UPPER_QUANTILE,
    trainedFrom: meta.trainedFrom,
    trainedTo: meta.trainedTo,
    sourceName: meta.source.name,
    attribution: meta.source.attribution,
    licence: { id: meta.source.licence, url: table.licenceUrl },
    stops,
  };
}
