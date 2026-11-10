/** `?at=2026-11-05T14:23:10Z`: the moment of a playback, in UTC to the second. */
export const AT_PARAM = "at";

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Unix seconds of an `at` value, null when it is not a real UTC moment in that form. */
export function parseAt(value: string | null): number | null {
  const match = value === null ? null : ISO.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return real && Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function formatAt(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

export function atOf(search: string): number | null {
  return parseAt(new URLSearchParams(search).get(AT_PARAM));
}

/** The address search with the moment written in (or taken out), every other parameter as it was. */
export function writeAt(search: string, at: number | null): string {
  const params = new URLSearchParams(search);
  params.delete(AT_PARAM);
  const rest = params.toString();
  const moment = at === null ? "" : `${AT_PARAM}=${formatAt(at)}`;
  const query = [rest, moment].filter((part) => part !== "").join("&");
  return query === "" ? "" : `?${query}`;
}
