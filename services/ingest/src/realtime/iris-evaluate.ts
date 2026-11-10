import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TripObservation } from "@gerlines/schema";
import { adaptIris, IrisChanges, type IrisEndpoint, IrisPlans } from "./iris.ts";
import type { Matcher, MatchOutcome } from "./matcher.ts";

export interface IrisAnswer {
  readonly endpoint: IrisEndpoint;
  readonly eva: number;
  readonly observedAt: number;
  readonly payload: Uint8Array;
}

interface Tally {
  trips: number;
  matched: number;
  placedStops: number;
  unplacedStops: number;
  readonly methods: Record<string, number>;
  readonly unmatched: Record<string, number>;
}

export interface IrisMatchReport {
  readonly answers: number;
  readonly failedAnswers: number;
  readonly trips: number;
  readonly matched: number;
  /** By the timetable category of the matched run, and by IRIS's own category label for every trip. */
  readonly byTimetableCategory: Record<string, Tally>;
  readonly byIrisCategory: Record<string, Tally>;
  /** By IRIS's filter: F long distance, N regional, S S-Bahn, D other operators, none when unnamed. */
  readonly byIrisFilter: Record<string, Tally>;
}

const tally = (): Tally => ({
  trips: 0,
  matched: 0,
  placedStops: 0,
  unplacedStops: 0,
  methods: {},
  unmatched: {},
});

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function filterOf(trip: TripObservation): string {
  if (trip.longDistance === true) return "F";
  if (trip.longDistance === false) return "not F";
  return "unnamed";
}

function groupOf(groups: Record<string, Tally>, key: string): Tally {
  const found = groups[key];
  if (found) return found;
  const created = tally();
  groups[key] = created;
  return created;
}

/** Each trip's last observation, after folding the answers in observation order into one pair of books. */
function lastObservations(answers: readonly IrisAnswer[]): {
  trips: TripObservation[];
  failedAnswers: number;
} {
  const state = { plans: new IrisPlans(), changes: new IrisChanges() };
  const last = new Map<string, TripObservation>();
  let failedAnswers = 0;
  for (const answer of [...answers].sort((a, b) => a.observedAt - b.observedAt)) {
    const result = adaptIris(answer.payload, answer.endpoint, answer.eva, answer.observedAt, state);
    if (!result.ok) failedAnswers += 1;
    else
      for (const event of result.events) if (event.kind === "trip") last.set(event.entityId, event);
  }
  const trips = [...last.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
  return { trips, failedAnswers };
}

function add(group: Tally, outcome: MatchOutcome): void {
  group.trips += 1;
  if (outcome.kind !== "matched") {
    count(group.unmatched, `${outcome.kind}:${outcome.reason}`);
    return;
  }
  group.matched += 1;
  group.placedStops += outcome.placements.length;
  group.unplacedStops += outcome.unplacedStops;
  count(group.methods, outcome.method);
}

/** Matches each IRIS trip with a change once: how many find their train, by category. */
export function evaluateIris(answers: readonly IrisAnswer[], matcher: Matcher): IrisMatchReport {
  const { trips, failedAnswers } = lastObservations(answers);
  const byTimetableCategory: Record<string, Tally> = {};
  const byIrisCategory: Record<string, Tally> = {};
  const byIrisFilter: Record<string, Tally> = {};
  let matched = 0;
  for (const trip of trips) {
    const outcome = matcher.match(trip);
    add(groupOf(byIrisCategory, trip.categoryLabel ?? "unnamed"), outcome);
    add(groupOf(byIrisFilter, filterOf(trip)), outcome);
    if (outcome.kind !== "matched") continue;
    matched += 1;
    add(groupOf(byTimetableCategory, outcome.run.trip.categoryCode), outcome);
  }
  return {
    answers: answers.length,
    failedAnswers,
    trips: trips.length,
    matched,
    byTimetableCategory,
    byIrisCategory,
    byIrisFilter,
  };
}

interface RequestLine {
  readonly endpoint?: unknown;
  readonly eva?: unknown;
  readonly startedAt?: unknown;
  readonly status?: unknown;
  readonly file?: unknown;
}

/** The answers of a `db-apis probe` or `iris-run` folder, from its `requests.jsonl`. */
export async function readProbeAnswers(dir: string): Promise<IrisAnswer[]> {
  const lines = (await readFile(join(dir, "requests.jsonl"), "utf8")).split("\n").filter(Boolean);
  const answers: IrisAnswer[] = [];
  for (const text of lines) {
    const line = JSON.parse(text) as RequestLine;
    const endpoint = line.endpoint;
    if (endpoint !== "plan" && endpoint !== "fchg" && endpoint !== "rchg") continue;
    if (line.status !== 200 || typeof line.file !== "string" || typeof line.eva !== "number") {
      continue;
    }
    if (line.file.split(/[\\/]/).includes(".."))
      throw new Error(`file outside the folder: ${line.file}`);
    answers.push({
      endpoint,
      eva: line.eva,
      observedAt: Date.parse(String(line.startedAt)),
      payload: await readFile(join(dir, line.file)),
    });
  }
  return answers;
}
