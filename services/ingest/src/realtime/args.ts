import { isAbsolute } from "node:path";
import { REALTIME_SOURCES } from "./adapters.ts";
import { IRIS_SOURCE, irisRecordedSources } from "./iris.ts";

/** An instant given as an ISO date and time; a typo is an error, not a silent empty range. */
export function instantArg(name: string, value: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant))
    throw new Error(`--${name} is not a date and time: ${value.slice(0, 40)}`);
  return instant;
}

/** A number in a range; `fallback` when the option is absent. */
export function numberArg(
  name: string,
  value: string | undefined,
  fallback: number,
  range: { readonly min: number; readonly max?: number; readonly exclusiveMin?: boolean },
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  const low = range.exclusiveMin ? number > range.min : number >= range.min;
  if (value.trim() === "" || !Number.isFinite(number) || !low || number > (range.max ?? Infinity)) {
    throw new Error(
      `--${name} must be a number ${range.exclusiveMin ? "above" : "of at least"} ${range.min}`,
    );
  }
  return number;
}

/**
 * Realtime sources by name: only the known ones, so no path outside the recordings is listed.
 * `db-iris` stands for every recorded DB Timetables answer of the long-distance cover.
 */
export function sourcesArg(value: string | undefined): string[] {
  if (value === undefined) return [...REALTIME_SOURCES];
  const sources = value.split(",").map((source) => source.trim());
  const unknown = sources.filter(
    (source) => source !== IRIS_SOURCE && !REALTIME_SOURCES.includes(source),
  );
  if (sources.length === 0 || unknown.length > 0) {
    throw new Error(`--sources names unknown sources: ${unknown.join(",").slice(0, 120)}`);
  }
  return [
    ...new Set(
      sources.flatMap((source) => (source === IRIS_SOURCE ? irisRecordedSources() : [source])),
    ),
  ];
}

/**
 * Options of `iris-match`: an absolute probe folder and the DELFI versions to match against. It
 * reads in read-only transactions, yet a database other than a throwaway copy still needs
 * `--allow-shared`, as for every other command.
 */
export function irisMatchArgs(values: {
  readonly dir?: string;
  readonly "feed-version-ids"?: string;
  readonly "allow-shared"?: boolean;
}): { dir: string; feedVersionIds: number[]; allowShared: boolean } {
  const dir = values.dir?.trim() ?? "";
  if (!isAbsolute(dir)) throw new Error("--dir must be an absolute path");
  const ids = values["feed-version-ids"]?.split(",").map(Number) ?? [];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error("--feed-version-ids must name the DELFI versions to match against");
  }
  return { dir, feedVersionIds: ids, allowShared: values["allow-shared"] === true };
}
