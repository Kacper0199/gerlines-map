import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeKeyframe, frameToObject, type Keyframe } from "@gerlines/live-frame";

const USAGE = `Usage: node e2e/fixture/build-details.ts --keyframe <file> --details <dir> --out <dir> --keys <key,key,...>

Pairs trips of the committed keyframe with the train details that "node src/detail/cli.ts render --at <instant> --out <dir>"
(services/live) built for the same instant, by train number, line and the time of every plan stop, and writes for each
pair <out>/trains/<tripInstanceId>.json (the detail as built) and <out>/keys/<key>.json ({ "tripInstanceId": ... }),
the two answers the API gives for /api/v1/live/keys/<key> and /api/v1/trains/<id>. A trip without exactly one match
stops the run.
`;

const { values } = parseArgs({
  options: {
    keyframe: { type: "string" },
    details: { type: "string" },
    out: { type: "string" },
    keys: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !(values.keyframe && values.details && values.out && values.keys)) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 2);
}

interface DetailStop {
  readonly predictedArrival: string | null;
  readonly predictedDeparture: string | null;
  readonly scheduledArrival: string | null;
  readonly scheduledDeparture: string | null;
}
interface Detail {
  readonly tripInstanceId: string;
  readonly trainNumber: string | null;
  readonly line: string | null;
  readonly stops: readonly DetailStop[];
}

const keyframe = frameToObject(
  decodeKeyframe(new Uint8Array(readFileSync(values.keyframe))),
) as Keyframe;
const wanted = new Set(values.keys.split(",").map(Number));
const trips = keyframe.trips.filter((trip) => wanted.has(trip.key));
if (trips.length !== wanted.size) throw new Error("a key is not in the keyframe");

const detailsDirectory = values.details;
const details: Detail[] = readdirSync(detailsDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(detailsDirectory, name), "utf8")) as Detail);

function seconds(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso) / 1000;
}

function sameTimes(trip: Keyframe["trips"][number], detail: Detail): boolean {
  const known = trip.stops.filter((stop) => (stop.arrival ?? stop.departure) !== null);
  const tail = detail.stops.slice(detail.stops.length - trip.stops.length);
  if (tail.length !== trip.stops.length) return false;
  return known.every((stop) => {
    const index = trip.stops.indexOf(stop);
    const candidate = tail[index];
    if (!candidate) return false;
    const departure = seconds(candidate.predictedDeparture ?? candidate.scheduledDeparture);
    const arrival = seconds(candidate.predictedArrival ?? candidate.scheduledArrival);
    return (
      (stop.departure === null || departure === null || stop.departure === departure) &&
      (stop.arrival === null || arrival === null || stop.arrival === arrival)
    );
  });
}

rmSync(values.out, { recursive: true, force: true });
mkdirSync(join(values.out, "trains"), { recursive: true });
mkdirSync(join(values.out, "keys"), { recursive: true });
for (const trip of trips) {
  const matches = details.filter(
    (detail) =>
      detail.trainNumber === String(trip.trainNumber) &&
      detail.line === trip.line &&
      sameTimes(trip, detail),
  );
  if (matches.length !== 1) {
    throw new Error(
      `trip ${trip.key} (${trip.line} ${trip.trainNumber}) has ${matches.length} matches`,
    );
  }
  const [detail] = matches as [Detail];
  writeFileSync(
    join(values.out, "trains", `${detail.tripInstanceId}.json`),
    `${JSON.stringify(detail)}\n`,
  );
  writeFileSync(
    join(values.out, "keys", `${trip.key}.json`),
    `${JSON.stringify({ tripInstanceId: detail.tripInstanceId })}\n`,
  );
  process.stdout.write(
    `${trip.key} ${trip.line} ${trip.trainNumber} -> ${detail.tripInstanceId}\n`,
  );
}
