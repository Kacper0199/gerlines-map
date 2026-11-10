import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeHead, decodeKeyframe, frameToObject, type TripRecord } from "@gerlines/live-frame";

const USAGE = `usage: node apps/web/scripts/find-trips.ts <replay folder> [--series RE] [--operator RE] [--line RE] [--limit N] [--sequence N]

Lists the trips of the newest keyframe (or of keyframe N, the files in <folder>/k) of a replay folder (data/live/<run>) as tab separated rows
(key, line, train number, series, operator, units, category) for the dev hook
window.gerlinesCheck.showTrain(key). Each filter is a case-insensitive regular expression.`;

export interface TripFilters {
  readonly series?: string | undefined;
  readonly operator?: string | undefined;
  readonly line?: string | undefined;
}

function matches(pattern: string | undefined, value: string | null | undefined): boolean {
  return pattern === undefined || new RegExp(pattern, "i").test(value ?? "");
}

export function matchTrips(trips: readonly TripRecord[], filters: TripFilters): TripRecord[] {
  return trips.filter(
    (trip) =>
      !trip.cancelled &&
      matches(filters.series, trip.series) &&
      matches(filters.operator, trip.operator) &&
      matches(filters.line, trip.line),
  );
}

export function rowOf(trip: TripRecord): string {
  return [
    trip.key,
    trip.line ?? "-",
    trip.trainNumber ?? "-",
    trip.series ?? "-",
    trip.operator ?? "-",
    trip.units ?? "-",
    trip.category,
  ].join("\t");
}

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
}

function main(argv: readonly string[]): void {
  const folder = argv[0];
  if (!folder || folder.startsWith("--")) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const head = decodeHead(new Uint8Array(readFileSync(join(folder, "head"))));
  const sequence = Number(option(argv, "sequence") ?? head.keyframeSequence);
  const path = join(folder, "k", `${sequence}.bin`);
  const frame = frameToObject(decodeKeyframe(new Uint8Array(readFileSync(path))));
  const filters: TripFilters = {
    series: option(argv, "series"),
    operator: option(argv, "operator"),
    line: option(argv, "line"),
  };
  const limit = Number(option(argv, "limit") ?? 50);
  const found = matchTrips(frame.trips, filters);
  process.stdout.write(`${found.slice(0, limit).map(rowOf).join("\n")}\n`);
  process.stderr.write(`${found.length} of ${frame.trips.length} trips (sequence ${sequence})\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
