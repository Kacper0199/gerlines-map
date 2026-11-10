import type { Locale } from "@gerlines/i18n";
import type { StatsDelayBin, StatsHour, StatsNetwork, StatsSummary } from "@gerlines/schema/stats";
import { numberFormat } from "./format.ts";

export type DelayClass = "ok" | "minor" | "major" | "severe";

export interface DelayClassTotals {
  readonly ok: number;
  readonly minor: number;
  readonly major: number;
  readonly severe: number;
  readonly total: number;
}

export const DELAY_CLASSES: readonly DelayClass[] = ["ok", "minor", "major", "severe"];

const MINOR_FROM_S = 180;
const MAJOR_FROM_S = 360;
const SEVERE_FROM_S = 900;

/** The classes of the Delay colour mode (DESIGN.md): early counts as on time. */
export function delayClassOf(lowerBoundS: number): DelayClass {
  if (lowerBoundS < MINOR_FROM_S) return "ok";
  if (lowerBoundS < MAJOR_FROM_S) return "minor";
  if (lowerBoundS < SEVERE_FROM_S) return "major";
  return "severe";
}

export function binClass(bin: StatsDelayBin): DelayClass {
  return delayClassOf(bin.fromS ?? Number.NEGATIVE_INFINITY);
}

export function delayClasses(histogram: readonly StatsDelayBin[]): DelayClassTotals {
  const sums = { ok: 0, minor: 0, major: 0, severe: 0 };
  for (const bin of histogram) sums[binClass(bin)] += bin.count;
  return { ...sums, total: sums.ok + sums.minor + sums.major + sums.severe };
}

/** The lower edge of a bin in whole minutes, the open last bin with a plus. */
/** Whole minutes with a true minus sign, which is as wide as the plus and does not read as a hyphen. */
export function signedMinutes(minutes: number): string {
  return minutes < 0 ? `\u2212${-minutes}` : String(minutes);
}

export function binLabelMinutes(bin: StatsDelayBin): string {
  if (bin.fromS === null) return "";
  const minutes = signedMinutes(Math.round(bin.fromS / 60));
  return bin.toS === null ? `${minutes}+` : minutes;
}

type StatsByCategory = StatsNetwork["byCategory"][number];

export const MAP_CATEGORIES = ["hsr", "ld", "night", "rfast", "reg", "sbahn"] as const;

export interface CategoryEntry {
  readonly category: StatsByCategory["category"];
  /** The answer's row, null for a map category that had no stops in the period. */
  readonly row: StatsByCategory | null;
}

/** Every map category in the legend order, then whatever else the answer carries. */
export function categoryEntries(rows: readonly StatsByCategory[]): CategoryEntry[] {
  const onMap = MAP_CATEGORIES.map((category) => ({
    category,
    row: rows.find((row) => row.category === category) ?? null,
  }));
  const other = rows
    .filter((row) => !(MAP_CATEGORIES as readonly (string | null)[]).includes(row.category))
    .map((row) => ({ category: row.category, row }));
  return [...onMap, ...other];
}

export function hourSeries(hours: readonly StatsHour[]): StatsHour[] {
  const byHour = new Map(hours.map((entry) => [entry.hour, entry]));
  return Array.from(
    { length: 24 },
    (_, hour) =>
      byHour.get(hour) ?? {
        hour,
        stops: 0,
        cancelled: 0,
        observedArrivals: 0,
        punctual6: null,
        meanDelayS: null,
      },
  );
}

const TENTHS_PER_SHARE = 1000;
const TIE_TOLERANCE = 1e-9;

/**
 * A share in percent with one decimal, rounded half up on its decimal digits. The API gives
 * shares with four decimals; the tolerance keeps a tie such as 0.4305 from falling to 43.0
 * through the binary error of 0.4305 times 1000.
 */
export function percentNumber(share: number): number {
  return Math.floor(share * TENTHS_PER_SHARE + 0.5 + TIE_TOLERANCE) / 10;
}

export function percentSign(locale: Locale): string {
  return locale === "de" ? "\u00a0%" : "%";
}

/** A share above zero that one decimal would show as 0.0. */
export function isTinyShare(share: number): boolean {
  return share > 0 && percentNumber(share) === 0;
}

const SMALLEST_SHOWN_PERCENT = 0.1;

/** A share in percent; with `under`, a tiny but real share reads as under 0.1 and not as zero. */
export function percentOf(
  share: number | null,
  locale: Locale,
  under?: (value: string) => string,
): string | null {
  if (share === null) return null;
  const sign = percentSign(locale);
  if (under !== undefined && isTinyShare(share)) {
    return under(`${numberFormat(locale, 1).format(SMALLEST_SHOWN_PERCENT)}${sign}`);
  }
  return `${numberFormat(locale, 1).format(percentNumber(share))}${sign}`;
}

export type DurationParts =
  | { readonly unit: "s"; readonly value: number }
  | { readonly unit: "min"; readonly value: number }
  | { readonly unit: "h"; readonly value: number; readonly minutes: number };

const SECONDS_UP_TO = 90;
const MINUTES_UP_TO = 7200;

export function durationParts(seconds: number | null): DurationParts | null {
  if (seconds === null) return null;
  const size = Math.abs(seconds);
  if (size < SECONDS_UP_TO) return { unit: "s", value: Math.round(seconds) };
  if (size < MINUTES_UP_TO) return { unit: "min", value: Math.round(seconds / 6) / 10 };
  const sign = seconds < 0 ? -1 : 1;
  const whole = Math.floor(size / 60);
  return { unit: "h", value: sign * Math.floor(whole / 60), minutes: whole % 60 };
}

const PRODUCT_LINE = /^([A-Za-z]{1,4})\d*$/;

/**
 * The product letters the lines of a train number carry (IC35 gives IC), when every line that
 * has one agrees. Never guessed from the category: a number without a line stays a number.
 */
export function productOfLines(lines: readonly (string | null)[]): string | null {
  const products = new Set<string | null>();
  for (const line of lines) {
    if (line === null) continue;
    products.add(PRODUCT_LINE.exec(line)?.[1] ?? null);
  }
  const [only] = products;
  return products.size === 1 && only !== undefined ? only : null;
}

export type EmptyReason = "no-stops" | "no-realtime" | "no-arrivals";

/** Why a summary has no headline share: nothing ran, nothing was observed, or no arrival was. */
export function emptyReason(summary: StatsSummary): EmptyReason | null {
  if (summary.punctual6 !== null) return null;
  if (summary.stops === 0) return "no-stops";
  if (summary.observed === 0) return "no-realtime";
  return "no-arrivals";
}

export function durationText(
  seconds: number | null,
  locale: Locale,
  minutesWord: string,
): string | null {
  const parts = durationParts(seconds);
  if (parts === null) return null;
  switch (parts.unit) {
    case "s":
      return `${numberFormat(locale, 0).format(parts.value)} s`;
    case "min":
      return `${numberFormat(locale, 1).format(parts.value)} ${minutesWord}`;
    case "h":
      return `${numberFormat(locale, 0).format(parts.value)} h ${numberFormat(locale, 0).format(parts.minutes)} ${minutesWord}`;
  }
}
