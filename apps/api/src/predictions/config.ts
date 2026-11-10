import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import type { TrainDetail, TrainForecast } from "@gerlines/schema";
import { ConfigurationError } from "../config.ts";
import { type EvaOf, forecastOf } from "./forecast.ts";
import { PredictionTable } from "./table.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const MAX_TABLE_BYTES = 512 * 1024 * 1024;

export interface Forecaster {
  forecast(detail: TrainDetail): TrainForecast | null;
}

/** Reads a table file written by `gerlines-predict table` (gzipped JSON, or plain JSON). */
export function readPredictionTable(path: string): PredictionTable {
  const bytes = readFileSync(path);
  const body =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_TABLE_BYTES })
      : bytes;
  return PredictionTable.parse(JSON.parse(body.toString("utf8")));
}

/**
 * The forecaster from `PREDICTION_TABLE` (an absolute path to the B1 table) and a lookup of EVA
 * numbers by stop place; undefined when the variable is unset, and details keep `forecast: null`.
 */
export function predictionsFromEnv(
  env: Environment,
  evaOf: () => EvaOf | null,
): Forecaster | undefined {
  const path = env.PREDICTION_TABLE?.trim();
  if (!path) return undefined;
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    throw new ConfigurationError("PREDICTION_TABLE must be an absolute path to a file");
  }
  const table = readPredictionTable(path);
  return {
    forecast(detail) {
      const lookup = evaOf();
      return lookup ? forecastOf(detail, table, lookup) : null;
    },
  };
}
