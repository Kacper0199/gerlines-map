import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = resolve(here, "../../../design/variants/data");
const meta = JSON.parse(readFileSync(resolve(data, "meta.json"), "utf8"));
const train = JSON.parse(readFileSync(resolve(data, "ice379.json"), "utf8"));

const capturedDay = meta.capturedAt.slice(0, 10);
const BERLIN_SUMMER_OFFSET_HOURS = 2;

function berlinClockToIso(clock) {
  const [hours, minutes] = clock.split(":").map(Number);
  const utc = new Date(`${capturedDay}T00:00:00Z`);
  utc.setUTCHours(hours - BERLIN_SUMMER_OFFSET_HOURS, minutes);
  return utc.toISOString();
}

const next = train.stops[train.nextStopIndex];

const sample = {
  source:
    "design/variants/data/meta.json and ice379.json, Transitous over DELFI, captured 2026-10-23",
  capturedAt: meta.capturedAt,
  trainsTotal: meta.trainsTotal,
  trainsRealtime: meta.trainsRealtime,
  countsByCategory: meta.countsByCategory,
  train: {
    line: train.line,
    category: train.category,
    operator: train.operator,
    origin: train.origin,
    destination: train.destination,
    delayMinutes: train.currentDelay,
    nextStop: {
      name: next.name,
      scheduledArrivalAt: berlinClockToIso(next.arrSched),
      arrivalAt: berlinClockToIso(next.arr),
      departureAt: berlinClockToIso(next.dep),
      platform: next.track,
      scheduledPlatform: next.trackSched,
    },
  },
};

writeFileSync(resolve(here, "../fixtures/sample.json"), `${JSON.stringify(sample, null, 2)}\n`);
