/**
 * Shadow check, step 1: what the train card would have shown at given replay instants.
 *
 * For each instant it builds every running train's detail from DATABASE_URL in history mode (the
 * state as of the instant from `stop_event_forecast`, the code path of `live detail render`), runs
 * the API's B1 forecaster on it (`forecastOf` with the served table), and writes one gzipped JSON
 * line per train and per served stop ahead (up to the table's maxAhead): the current delay the
 * forecast starts from, the feed's own predicted arrival delay at that stop as of the instant, the
 * B1 expected and p80 delays (the forecaster run on the detail without the feed's predictions
 * ahead), and the card's expected and upper delays with their basis (the forecaster as served,
 * D-065). Finals are joined later by `gerlines_predict.shadow`.
 *
 * Usage: node pipelines/predict/scripts/shadow_details.ts --table <b1 table> --out <file.jsonl.gz>
 *        --at <ISO instant> [--at ...]
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { readPredictionTable } from "../../../apps/api/src/predictions/config.ts";
import { forecastOf } from "../../../apps/api/src/predictions/forecast.ts";
import { createDatabase } from "../../../packages/db/src/index.ts";
import type { TrainDetail } from "../../../packages/schema/src/index.ts";
import { buildAll, DetailRepository, runningAt } from "../../../services/live/src/detail/index.ts";

const BATCH = 500;
const TRAIN_NUMBER = /^\d{1,9}$/;

const { values } = parseArgs({
  options: {
    table: { type: "string" },
    out: { type: "string" },
    at: { type: "string", multiple: true },
  },
});
if (!values.table || !values.out || !values.at?.length) throw new Error("--table, --out, --at");
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL must name the database to read");

const table = readPredictionTable(values.table);
const db = createDatabase({
  databaseUrl,
  applicationName: "gerlines-t150-shadow",
  maxConnections: 4,
});
const gzip = createGzip();
gzip.pipe(createWriteStream(values.out));
const write = (row: unknown[]) => gzip.write(`${JSON.stringify(row)}\n`);

function withoutFeedAhead(detail: TrainDetail): TrainDetail {
  const passed = detail.progress.lastPassedIndex ?? -1;
  return {
    ...detail,
    stops: detail.stops.map((stop) =>
      stop.index > passed ? { ...stop, predictedArrival: null, arrivalDelaySeconds: null } : stop,
    ),
  };
}

function nullReason(detail: {
  progress: { lastPassedIndex: number | null };
  trainNumber: string | null;
}): string {
  if (detail.progress.lastPassedIndex === null) return "no_passed_stop";
  if (detail.trainNumber === null || !TRAIN_NUMBER.test(detail.trainNumber)) return "no_number";
  return "other";
}

try {
  const places = await db.selectFrom("stop_place").select(["stop_place_id", "eva"]).execute();
  const evaById = new Map(places.map((row) => [row.stop_place_id, row.eva ?? null]));
  const evaOf = (id: string) => evaById.get(id) ?? null;
  const repository = new DetailRepository(db);
  for (const atText of values.at) {
    const at = Date.parse(atText);
    if (Number.isNaN(at)) throw new Error(`--at ${atText} is not an ISO instant`);
    const iso = new Date(at).toISOString();
    const refs = await runningAt(db, at);
    let trains = 0;
    for (let start = 0; start < refs.length; start += BATCH) {
      const loaded = await repository.load(refs.slice(start, start + BATCH), at, "history");
      const { details } = buildAll(loaded, {
        asOf: at,
        version: Math.floor(at / 1000),
        timetableVersion: (instance) => String(instance.ref.feedVersionId ?? 0),
      });
      for (const detail of details) {
        if (detail.provenance.kind !== "realtime") continue;
        trains += 1;
        const forecast = forecastOf(withoutFeedAhead(detail), table, evaOf);
        const card = forecastOf(detail, table, evaOf);
        const passedIndex = detail.progress.lastPassedIndex;
        const position = detail.stops.findIndex((stop) => stop.index === passedIndex);
        const from = position >= 0 ? detail.stops[position] : undefined;
        const fromDelay = from ? (from.departureDelaySeconds ?? from.arrivalDelaySeconds) : null;
        write([
          "t",
          iso,
          detail.tripInstanceId,
          detail.serviceDate,
          detail.category,
          detail.trainNumber,
          detail.provenance.sourceId,
          passedIndex,
          fromDelay,
          forecast ? forecast.stops.length : 0,
          forecast ? null : nullReason(detail),
          detail.productName,
        ]);
        if (!from || from.cancelled) continue;
        const b1 = new Map((forecast?.stops ?? []).map((stop) => [stop.index, stop]));
        const shown = new Map((card?.stops ?? []).map((stop) => [stop.index, stop]));
        let ahead = 0;
        for (const stop of detail.stops.slice(position + 1)) {
          if (stop.cancelled) continue;
          ahead += 1;
          if (ahead > table.meta.maxAhead) break;
          const found = b1.get(stop.index);
          const served = shown.get(stop.index);
          write([
            "s",
            iso,
            detail.tripInstanceId,
            stop.index,
            ahead,
            stop.scheduledArrival,
            stop.arrivalDelaySeconds,
            stop.prediction,
            evaOf(stop.stopPlaceId),
            found?.expectedDelayMinutes ?? null,
            found?.upperDelayMinutes ?? null,
            found?.level ?? null,
            found?.runs ?? null,
            served?.expectedDelayMinutes ?? null,
            served?.upperDelayMinutes ?? null,
            served?.basis ?? null,
          ]);
        }
      }
    }
    process.stderr.write(`${iso} running ${refs.length} realtime ${trains}\n`);
  }
} finally {
  await db.destroy();
  await new Promise((resolve) => gzip.end(resolve));
}
