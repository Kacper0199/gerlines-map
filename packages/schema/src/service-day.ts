export const TIMETABLE_TIME_ZONE = "Europe/Berlin";

const DAY_MS = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMETABLE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function offsetMs(epochMs: number): number {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(epochMs / 1000) * 1000;
}

const referenceCache = new Map<string, number>();

/** The instant GTFS time 0 of a service day stands for: local noon minus 12 hours (GTFS reference). */
export function serviceDayReference(serviceDate: string): number {
  const cached = referenceCache.get(serviceDate);
  if (cached !== undefined) return cached;
  const noonAsUtc = Date.parse(`${serviceDate}T12:00:00Z`);
  const noon = noonAsUtc - offsetMs(noonAsUtc - offsetMs(noonAsUtc));
  const reference = noon - 12 * 3_600_000;
  referenceCache.set(serviceDate, reference);
  return reference;
}

/** Epoch milliseconds of a GTFS time (seconds after the reference, may pass 24 h) on a service day. */
export function serviceInstant(serviceDate: string, seconds: number): number {
  return serviceDayReference(serviceDate) + seconds * 1000;
}

export function gtfsTimeToSeconds(value: string): number | null {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function gtfsDateToIso(value: string): string | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return null;
  return date;
}

/** The Europe/Berlin calendar date (YYYY-MM-DD) of an instant in epoch milliseconds. */
export function localDate(epochMs: number): string {
  return new Date(epochMs + offsetMs(epochMs)).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday 0 to Sunday 6, matching the `weekdays` bit mask of `service_calendar`. */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}
