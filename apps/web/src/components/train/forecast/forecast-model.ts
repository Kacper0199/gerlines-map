import type { ForecastBasis, TrainDetail } from "@gerlines/schema";

export const FORECAST_ROWS = 5;

export interface ForecastRow {
  readonly index: number;
  readonly name: string;
  readonly expectedMinutes: number;
  readonly upperMinutes: number;
  readonly level: "train" | "stop" | "category";
  readonly basis: ForecastBasis;
}

export interface ForecastModel {
  readonly fromName: string;
  readonly fromDelayMinutes: number;
  readonly rows: readonly ForecastRow[];
  readonly more: number;
  readonly feedSourceName: string | null;
  readonly historyRows: boolean;
  readonly trainedFrom: string;
  readonly trainedTo: string;
  readonly sourceName: string;
  readonly attribution: string;
  readonly licence: { readonly id: string; readonly url: string | null };
}

/**
 * The card's forecast block from the detail: the next stops the API forecast, in route order, at
 * most `FORECAST_ROWS` of them with the count of the rest, each with its basis (D-065). The feed's
 * name is set when a shown row anchors on its forecast, and `historyRows` when a shown row is B1
 * alone. Null for a cancelled or timetable-only train and when the API sent no forecast.
 */
export function forecastModel(detail: TrainDetail): ForecastModel | null {
  const forecast = detail.forecast ?? null;
  if (forecast === null || detail.cancelled || detail.provenance.kind !== "realtime") return null;
  const names = new Map(detail.stops.map((stop) => [stop.index, stop.name]));
  const fromName = names.get(forecast.fromIndex);
  if (fromName === undefined) return null;
  const rows = forecast.stops.flatMap((stop) => {
    const name = names.get(stop.index);
    return name === undefined
      ? []
      : [
          {
            index: stop.index,
            name,
            expectedMinutes: stop.expectedDelayMinutes,
            upperMinutes: stop.upperDelayMinutes,
            level: stop.level,
            basis: stop.basis ?? "b1",
          },
        ];
  });
  if (rows.length === 0) return null;
  const shown = rows.slice(0, FORECAST_ROWS);
  const anchored = shown.some((row) => row.basis === "feed_plus_spread");
  return {
    fromName,
    fromDelayMinutes: forecast.fromDelayMinutes,
    rows: shown,
    more: Math.max(0, rows.length - FORECAST_ROWS),
    feedSourceName: anchored ? detail.provenance.sourceName : null,
    historyRows: shown.some((row) => row.basis === "b1"),
    trainedFrom: forecast.trainedFrom,
    trainedTo: forecast.trainedTo,
    sourceName: forecast.sourceName,
    attribution: forecast.attribution,
    licence: forecast.licence,
  };
}
