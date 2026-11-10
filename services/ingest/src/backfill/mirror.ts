const HREF = /href="([^"?#]+)"/g;
function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return "";
  }
}

const DAY_FOLDER = /^(\d{4}-\d{2}-\d{2})\/$/;
const SNAPSHOT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\.gtfs-rt\.pbf$/;

/** Day folders (`YYYY-MM-DD/`) linked from an nginx autoindex page. */
export function parseDayFolders(html: string): string[] {
  const folders: string[] = [];
  for (const match of html.matchAll(HREF)) {
    const day = DAY_FOLDER.exec(decoded(match[1] ?? ""))?.[1];
    if (day) folders.push(day);
  }
  return folders.sort();
}

export interface MirrorSnapshot {
  readonly at: number;
  readonly href: string;
}

/** Original-feed snapshots of a day folder, keyed by their UTC instant (names carry a local offset). */
export function parseSnapshots(html: string): MirrorSnapshot[] {
  const snapshots: MirrorSnapshot[] = [];
  for (const match of html.matchAll(HREF)) {
    const href = match[1] ?? "";
    const stamp = SNAPSHOT.exec(decoded(href))?.[1];
    if (!stamp) continue;
    const at = Date.parse(stamp);
    if (!Number.isNaN(at)) snapshots.push({ at, href });
  }
  return snapshots.sort((a, b) => a.at - b.at);
}

const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The mirror's folders and archives are named by the German local date of the snapshot. */
export function mirrorDay(epochMs: number): string {
  return berlinDate.format(new Date(epochMs));
}

const HOUR_MS = 3_600_000;

/** The UTC instant at which a German local date begins. */
export function berlinDayStart(day: string): number {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  for (const offsetHours of [2, 1, 0]) {
    const candidate = midnightUtc - offsetHours * HOUR_MS;
    if (mirrorDay(candidate) === day && mirrorDay(candidate - 1) !== day) return candidate;
  }
  throw new Error(`cannot place the German day ${day}`);
}
