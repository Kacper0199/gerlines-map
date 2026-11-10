import type { WindowList } from "../live/playback/window-index.ts";

const ZONE = "Europe/Berlin";
const HOUR_S = 3600;

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export interface HourOption {
  /** Unix seconds of the window start. */
  readonly start: number;
  /** The hour on the Berlin wall clock, 0 to 23. */
  readonly hour: number;
  readonly available: boolean;
  /** The Berlin offset from UTC in hours (2 in summer, 1 in winter). */
  readonly offset: number;
  /** The wall clock shows this hour twice that day (the October change back), so the offset tells them apart. */
  readonly repeated: boolean;
}

export interface DayGroup {
  /** `YYYY-MM-DD` on the Berlin calendar. */
  readonly key: string;
  /** Unix seconds of the first hour listed for the day (to format the day's name). */
  readonly firstStart: number;
  readonly hours: readonly HourOption[];
}

function berlinFields(seconds: number): { day: string; hour: number; offset: number } {
  const fields: Record<string, string> = {};
  for (const part of parts.formatToParts(seconds * 1000)) {
    if (part.type !== "literal") fields[part.type] = part.value;
  }
  const hour = Number(fields.hour);
  const wall = Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), hour);
  return {
    day: `${fields.year}-${fields.month}-${fields.day}`,
    hour,
    offset: Math.round((wall / 1000 - seconds) / HOUR_S),
  };
}

function withRepeats(hours: readonly Omit<HourOption, "repeated">[]): HourOption[] {
  const counts = new Map<number, number>();
  for (const { hour } of hours) counts.set(hour, (counts.get(hour) ?? 0) + 1);
  return hours.map((option) => ({ ...option, repeated: (counts.get(option.hour) ?? 0) > 1 }));
}

/** `02:00`, and `02:00 UTC+2` where the day shows that hour twice. */
export function hourLabel(option: HourOption): string {
  const time = `${String(option.hour).padStart(2, "0")}:00`;
  if (!option.repeated) return time;
  return `${time} UTC${option.offset < 0 ? "-" : "+"}${Math.abs(option.offset)}`;
}

/** The start of the newest window that is settled at `now`, the last one worth listing. */
export function newestSettledStart(list: WindowList, now: number): number {
  const { windowSeconds, settleSeconds } = list.limits;
  return Math.floor((now - settleSeconds - windowSeconds) / windowSeconds) * windowSeconds;
}

/**
 * The hours a visitor can pick, grouped by Berlin day, newest day first and hours in order: every
 * hour from the oldest the server plays to the newest settled one, with the hours it has not
 * rendered marked unavailable, so a gap shows as a gap. Days with no rendered hour are left out.
 */
export function dayGroups(list: WindowList, now: number): DayGroup[] {
  const available = new Set(list.windows.map((window) => window.start));
  const { windowSeconds, maxAgeSeconds } = list.limits;
  const oldest = Math.ceil((now - maxAgeSeconds) / windowSeconds) * windowSeconds;
  const newest = newestSettledStart(list, now);
  const days = new Map<string, Omit<HourOption, "repeated">[]>();
  for (let start = oldest; start <= newest; start += windowSeconds) {
    const { day, hour, offset } = berlinFields(start);
    const hours = days.get(day) ?? [];
    hours.push({ start, hour, offset, available: available.has(start) });
    days.set(day, hours);
  }
  return [...days.entries()]
    .filter(([, hours]) => hours.some((hour) => hour.available))
    .map(([key, hours]) => ({
      key,
      firstStart: (hours[0] as { start: number }).start,
      hours: withRepeats(hours),
    }))
    .reverse();
}

/** The day group that holds a window start, undefined when it is not listed. */
export function dayOf(groups: readonly DayGroup[], start: number): DayGroup | undefined {
  return groups.find((group) => group.hours.some((hour) => hour.start === start));
}

/** The newest rendered hour, undefined when none is. */
export function newestAvailable(groups: readonly DayGroup[]): number | undefined {
  for (const group of groups) {
    const hours = group.hours.filter((hour) => hour.available);
    const last = hours.at(-1);
    if (last) return last.start;
  }
  return undefined;
}

export function hourStartOf(instant: number): number {
  return Math.floor(instant / HOUR_S) * HOUR_S;
}
