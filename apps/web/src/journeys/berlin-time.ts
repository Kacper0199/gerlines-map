const ZONE = "Europe/Berlin";
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fieldsOf(ms: number): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const part of parts.formatToParts(ms)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return fields;
}

const HOUR_MS = 3_600_000;
/** Berlin is one hour ahead of UTC in winter and two in summer. */
const BERLIN_OFFSETS_MS = [2 * HOUR_MS, HOUR_MS];

/** `YYYY-MM-DDTHH:mm` on the Berlin wall clock, as a `datetime-local` field holds it. */
export function isBerlinLocal(text: string): boolean {
  const match = LOCAL.exec(text);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  return (
    date.getUTCMonth() === (month as number) - 1 &&
    date.getUTCDate() === day &&
    (hour as number) < 24 &&
    (minute as number) < 60
  );
}

export function berlinLocalOf(ms: number): string {
  const f = fieldsOf(ms);
  const pad = (value: number | undefined) => String(value).padStart(2, "0");
  return `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

/**
 * The instant a Berlin wall clock time stands for; in the autumn overlap the earlier one, and a time
 * the spring change skips is read with the winter offset.
 */
export function berlinInstantOf(local: string): number | null {
  const match = LOCAL.exec(local);
  if (!(match && isBerlinLocal(local))) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const wall = Date.UTC(year as number, (month as number) - 1, day as number, hour, minute);
  const matching = BERLIN_OFFSETS_MS.map((offset) => wall - offset).filter(
    (ms) => berlinLocalOf(ms) === local,
  );
  return matching[0] ?? wall - HOUR_MS;
}
