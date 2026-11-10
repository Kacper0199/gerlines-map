import type { SearchKind, SearchResult, SearchTrain } from "@gerlines/schema/search";
import type { CategoryKey } from "@gerlines/ui";

export const GROUP_ORDER: readonly SearchKind[] = ["train", "line", "station", "place"];

export interface ResultGroup {
  readonly kind: SearchKind;
  readonly results: readonly { readonly result: SearchResult; readonly index: number }[];
}

/**
 * Results grouped by kind, groups ordered by their best result (the API ranks best first), each
 * result with its place in the keyboard order, which runs through the groups as drawn.
 */
export function groupResults(results: readonly SearchResult[]): ResultGroup[] {
  const kinds: SearchKind[] = [];
  for (const result of results) if (!kinds.includes(result.kind)) kinds.push(result.kind);
  let index = 0;
  return kinds.map((kind) => ({
    kind,
    results: results
      .filter((result) => result.kind === kind)
      .map((result) => ({ result, index: index++ })),
  }));
}

export function flatOrder(groups: readonly ResultGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.results.map((entry) => entry.result));
}

const NAMED: ReadonlySet<string> = new Set(["hsr", "ld", "night", "rfast", "reg", "sbahn"]);

export function categoryKeyOf(category: string, foreign = false): CategoryKey {
  if (foreign) return "foreign";
  return NAMED.has(category) ? (category as CategoryKey) : "reg";
}

/** A bare number never stands alone as a title (DESIGN.md train card rules). */
export function trainTitleOf(train: SearchTrain, numbered: (number: string) => string): string {
  return /^\d+$/.test(train.title) ? numbered(train.title) : train.title;
}

export type TrainTiming = "running" | "later" | "ended";

export function trainTimingOf(train: SearchTrain, nowMs: number): TrainTiming {
  if (Date.parse(train.departure) > nowMs) return "later";
  return Date.parse(train.arrival) >= nowMs ? "running" : "ended";
}
