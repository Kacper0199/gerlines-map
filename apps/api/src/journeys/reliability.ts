import { TrainCategory } from "@gerlines/schema";
import {
  JOURNEY_RELIABILITY_DAYS,
  JOURNEY_RELIABILITY_OPERATOR_MAX,
  JOURNEY_RELIABILITY_TRAINS_MAX,
  type JourneyReliabilityResponse,
  type TrainReliability,
} from "@gerlines/schema/journeys";
import { addDays, localDate } from "@gerlines/schema/service-day";
import type { StatsRunGroup, StatsTrain } from "@gerlines/schema/stats";
import { RELIABILITY_CACHE_ENTRIES, RELIABILITY_CACHE_MS } from "../limits.ts";
import { StatsCache } from "../stats/cache.ts";
import { gated, type ReadGate, readGate, STATS_READ_QUERIES } from "../stats/reads.ts";
import { foldName } from "./filters.ts";

export { RELIABILITY_CACHE_ENTRIES, RELIABILITY_CACHE_MS } from "../limits.ts";

const READS_IN_FLIGHT = 1;
const TRAIN_NUMBER = /^[0-9A-Za-z]{1,12}$/;
const OPERATOR_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&()'+-]*$/u;
const LEGAL_FORMS = new Set([
  "ag",
  "gmbh",
  "mbh",
  "co",
  "kg",
  "se",
  "ug",
  "ohg",
  "kgaa",
  "sa",
  "bv",
]);

export { type ReadGate, readGate, StatsBusyError } from "../stats/reads.ts";

export interface ReliabilityKey {
  readonly category: TrainCategory;
  readonly number: string;
  readonly operator: string | null;
}

/** What the statistics service answers for a train number (`StatsService.train`). */
export interface ReliabilitySource {
  train(
    number: string,
    operatorId: string | null,
    range: { from: string; to: string },
  ): Promise<StatsTrain>;
}

export function reliabilityCache(now: () => number = Date.now): StatsCache {
  return new StatsCache({ maxEntries: RELIABILITY_CACHE_ENTRIES, now });
}

export interface ReliabilityContext {
  readonly source: ReliabilitySource;
  readonly now: () => number;
  readonly cache?: StatsCache;
  readonly reads?: ReadGate;
}

/** The last 30 Berlin service days, today included. */
export function reliabilityRange(nowMs: number): { from: string; to: string } {
  const to = localDate(nowMs);
  return { from: addDays(to, 1 - JOURNEY_RELIABILITY_DAYS), to };
}

export type ParsedReliabilityQuery =
  | { readonly ok: true; readonly trains: ReliabilityKey[] }
  | { readonly ok: false; readonly message: string };

/** `train=<category>~<number>[~<operator>]`, repeated, at most 30. */
export function parseReliabilityQuery(values: readonly string[]): ParsedReliabilityQuery {
  if (values.length === 0) return { ok: false, message: "name at least one train" };
  if (values.length > JOURNEY_RELIABILITY_TRAINS_MAX) {
    return { ok: false, message: `at most ${JOURNEY_RELIABILITY_TRAINS_MAX} trains` };
  }
  const trains: ReliabilityKey[] = [];
  for (const value of values) {
    const [categoryText, number, ...rest] = value.split("~");
    const category = TrainCategory.safeParse(categoryText);
    const operator = rest.length === 0 ? null : rest.join("~").trim();
    const operatorValid =
      operator === null ||
      (operator.length > 0 &&
        operator.length <= JOURNEY_RELIABILITY_OPERATOR_MAX &&
        OPERATOR_NAME.test(operator));
    if (!(category.success && number && TRAIN_NUMBER.test(number) && operatorValid)) {
      return { ok: false, message: "each train is category~number with an optional ~operator" };
    }
    trains.push({ category: category.data, number, operator });
  }
  return { ok: true, trains };
}

/** DELFI pads trip numbers with zeros (001028); the rollups hold them as written by the sources (1028). */
export function lookupNumber(number: string): string {
  return number.replace(/^0+(?=\d)/, "");
}

function tokensOf(name: string): string[] {
  return foldName(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "" && !LEGAL_FORMS.has(token));
}

function leadingMatch(left: readonly string[], right: readonly string[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

function operatorKey(group: StatsRunGroup): string {
  return group.operator?.id ?? "";
}

/** The groups of one operator: the only one, or the one whose name the leg's operator starts like. */
function groupsOfOperator(
  groups: readonly StatsRunGroup[],
  operator: string | null,
): StatsRunGroup[] | null {
  const operators = [...new Set(groups.map(operatorKey))];
  if (operators.length <= 1) return [...groups];
  if (operator === null) return null;
  const wanted = tokensOf(operator);
  const scored = operators.map((id) => {
    const name = groups.find((group) => operatorKey(group) === id)?.operator?.name ?? id;
    return { id, score: leadingMatch(wanted, tokensOf(name)) };
  });
  const best = Math.max(...scored.map((entry) => entry.score));
  const winners = scored.filter((entry) => entry.score === best);
  if (best === 0 || winners.length !== 1) return null;
  return groups.filter((group) => operatorKey(group) === winners[0]?.id);
}

function firstObservedDay(groups: readonly StatsRunGroup[]): string | null {
  let first: string | null = null;
  for (const group of groups) {
    for (const day of group.byDay) {
      if (day.observedArrivals > 0 && (first === null || day.day < first)) first = day.day;
    }
  }
  return first;
}

function resolve(key: ReliabilityKey, train: StatsTrain | undefined): TrainReliability {
  const base = { category: key.category, number: key.number, operator: key.operator };
  const inCategory = (train?.groups ?? []).filter(
    (group) => group.category === key.category && group.summary.observedArrivals > 0,
  );
  if (inCategory.length === 0) return { status: "missing", ...base, reason: "no_observations" };
  const chosen = groupsOfOperator(inCategory, key.operator);
  if (chosen === null) return { status: "missing", ...base, reason: "ambiguous" };
  const rated = chosen.filter((group) => group.summary.punctual6 !== null);
  let observed = 0;
  let punctual = 0;
  let runs = 0;
  for (const group of rated) {
    const arrivals = group.summary.observedArrivals;
    observed += arrivals;
    punctual += Math.round((group.summary.punctual6 ?? 0) * arrivals);
    runs += group.runs;
  }
  if (observed === 0) return { status: "missing", ...base, reason: "no_observations" };
  return {
    status: "known",
    ...base,
    punctual6: punctual / observed,
    observedArrivals: observed,
    runs,
    firstDay: firstObservedDay(rated),
  };
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return results;
}

function cacheKeyOf(number: string, range: { from: string; to: string }): string {
  return `train|${number}|${range.from}|${range.to}`;
}

/** How many statistics reads the keys need: distinct numbers, padded ones as one, cached ones free. */
export function uncachedTrains(
  keys: readonly ReliabilityKey[],
  cache: StatsCache,
  nowMs: number,
): number {
  const range = reliabilityRange(nowMs);
  const numbers = new Set(keys.map((key) => lookupNumber(key.number)));
  return [...numbers].filter((number) => !cache.holds(cacheKeyOf(number, range))).length;
}

/**
 * Punctuality of each leg's train number over the last 30 days, read from the statistics rollups
 * (WP-7.2): the groups of the leg's category, narrowed to the leg's operator when several operators
 * run that number. Missing data stays missing with its reason. Each number is read once and kept
 * ten minutes in a bounded cache that requests share, also while the read runs. A request reads
 * one number at a time, so it holds at most the three queries of one train read of the six the
 * process allows; reads past the process-wide gate fail with `StatsBusyError`.
 */
export async function trainReliability(
  keys: readonly ReliabilityKey[],
  { source, now, cache = reliabilityCache(now), reads = readGate() }: ReliabilityContext,
): Promise<JourneyReliabilityResponse> {
  const range = reliabilityRange(now());
  const numbers = [...new Set(keys.map((key) => lookupNumber(key.number)))];
  const load = (number: string): Promise<StatsTrain> =>
    gated(reads, () => source.train(number, null, range), STATS_READ_QUERIES.train);
  const read = (number: string) =>
    cache.read(cacheKeyOf(number, range), RELIABILITY_CACHE_MS, () => load(number));
  const answers = await inBatches(numbers, READS_IN_FLIGHT, read);
  const byNumber = new Map(numbers.map((number, index) => [number, answers[index]]));
  const refreshed = answers.map((train) => train.freshness.refreshedAt).filter(Boolean);
  return {
    period: { ...range, days: JOURNEY_RELIABILITY_DAYS },
    refreshedAt: (refreshed.sort().at(-1) as string | undefined) ?? null,
    trains: keys.map((key) => resolve(key, byNumber.get(lookupNumber(key.number)))),
  };
}
