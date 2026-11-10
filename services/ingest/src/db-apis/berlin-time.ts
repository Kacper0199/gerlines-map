const BERLIN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function berlinParts(epochMs: number): LocalParts {
  const parts = Object.fromEntries(
    BERLIN.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The German local date (YYMMDD) and hour (HH) that DB Timetables uses in its plan path. */
export function berlinPlanSlot(epochMs: number): { readonly date: string; readonly hour: string } {
  const p = berlinParts(epochMs);
  return { date: `${pad(p.year % 100)}${pad(p.month)}${pad(p.day)}`, hour: pad(p.hour) };
}

function offsetMinutesAt(epochMs: number): number {
  const p = berlinParts(epochMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

const IRIS_TIME = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** True when the day exists in that month of 20YY (no 30 February, no 31 November). */
export function isCalendarDate(yy: number, mm: number, dd: number): boolean {
  if (mm < 1 || mm > 12 || dd < 1) return false;
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  return date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd;
}

/**
 * An IRIS time `YYMMddHHmm` in German local time as a UTC ISO string; null for a malformed value or
 * a day that does not exist. In the repeated hour of the autumn switch the instant nearest to
 * `referenceMs` (the time the answer was asked for) is chosen, the earlier one (summer time) without.
 */
export function irisTimeToIso(
  value: string | undefined,
  referenceMs: number | null = null,
): string | null {
  const match = value ? IRIS_TIME.exec(value) : null;
  if (!match) return null;
  const [, yy, mm, dd, hh, mi] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!isCalendarDate(yy, mm, dd) || hh > 23 || mi > 59) return null;
  const naive = Date.UTC(2000 + yy, mm - 1, dd, hh, mi);
  const candidates = [120, 60]
    .map((offset) => naive - offset * 60_000)
    .filter((instant) => offsetMinutesAt(instant) * 60_000 === naive - instant);
  const nearest =
    referenceMs === null
      ? candidates[0]
      : candidates.reduce<number | undefined>(
          (found, instant) =>
            found === undefined || Math.abs(instant - referenceMs) < Math.abs(found - referenceMs)
              ? instant
              : found,
          undefined,
        );
  const instant = nearest ?? naive - offsetMinutesAt(naive) * 60_000;
  return new Date(instant).toISOString();
}
