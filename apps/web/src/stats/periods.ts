import { STATS_MAX_DAYS } from "@gerlines/schema/stats";

export type PeriodChoice =
  | { readonly kind: "today" }
  | { readonly kind: "days"; readonly count: 7 | 30 }
  | { readonly kind: "month"; readonly year: number; readonly month: number }
  | { readonly kind: "custom"; readonly from: string; readonly to: string };

export interface MonthRef {
  readonly year: number;
  readonly month: number;
}

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export type RangeCheck =
  | { readonly ok: true; readonly days: number }
  | { readonly ok: false; readonly problem: "incomplete" | "order" | "too-long" };

/** The first month the statistics database can hold; earlier days are raised to it. */
export const FIRST_MONTH: MonthRef = { year: 2024, month: 1 };
export const FIRST_DAY = "2024-01-01";

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const berlinParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Berlin calendar date of an instant, the service day statistics count in. */
export function berlinDay(ms: number): string {
  return berlinParts.format(ms);
}

function dayToUtc(day: string): number | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, date);
  const ms = instant.getTime();
  const same =
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === date;
  return same ? ms : null;
}

function utcToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const ms = dayToUtc(day);
  if (ms === null) throw new RangeError(`not a calendar day: ${day}`);
  return utcToDay(ms + days * DAY_MS);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function monthOf(day: string): MonthRef {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function periodRange(choice: PeriodChoice, today: string): DayRange {
  switch (choice.kind) {
    case "today":
      return { from: today, to: today };
    case "days":
      return { from: addDays(today, 1 - choice.count), to: today };
    case "month": {
      const first = `${choice.year}-${pad(choice.month)}-01`;
      const last = addDays(
        `${shiftMonth(choice, 1).year}-${pad(shiftMonth(choice, 1).month)}-01`,
        -1,
      );
      return { from: first, to: last > today ? today : last };
    }
    case "custom":
      return { from: choice.from, to: choice.to };
  }
}

export function validateRange(from: string, to: string): RangeCheck {
  const start = dayToUtc(from);
  const end = dayToUtc(to);
  if (start === null || end === null) return { ok: false, problem: "incomplete" };
  if (end < start) return { ok: false, problem: "order" };
  const days = Math.round((end - start) / DAY_MS) + 1;
  return days > STATS_MAX_DAYS ? { ok: false, problem: "too-long" } : { ok: true, days };
}

function clampDay(day: string, today: string): string {
  if (dayToUtc(day) === null) return day;
  if (day < FIRST_DAY) return FIRST_DAY;
  return day > today ? today : day;
}

/**
 * A typed range held inside the days that can have statistics: not before the first data month,
 * not after today (later stops are only planned). An unfinished field and the order of the two
 * days are left for the message.
 */
export function clampRange(range: DayRange, today: string): DayRange {
  return { from: clampDay(range.from, today), to: clampDay(range.to, today) };
}

/** A period that starts on the first of a month and ends on the last of one, as Deutsche Bahn's monthly figures do. */
export function coversWholeMonths(range: DayRange): boolean {
  if (dayToUtc(range.from) === null || dayToUtc(range.to) === null) return false;
  return (
    range.from.endsWith("-01") && addDays(range.to, 1).endsWith("-01") && range.from <= range.to
  );
}
