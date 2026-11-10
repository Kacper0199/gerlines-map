/** The palette row every operator without a livery of a series falls back to: neutral colours, no logo. */
export const NEUTRAL_ROW = 0;

/** One livery of the forge's manifest and the trains it is for (tools/trainforge livery-rules.ts). */
export interface LiveryRuleEntry {
  readonly livery: string;
  readonly row: number;
  readonly operator: string;
  readonly group?: string;
  readonly series: readonly string[];
  readonly lines?: readonly string[];
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface LiveryManifest {
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly rules: readonly LiveryRuleEntry[];
}

/** The columns of a frame trip that choose a livery. */
export interface LiveryTrip {
  readonly series?: string | null;
  readonly operator?: string | null;
  readonly line?: string | null;
}

interface Candidate {
  readonly rule: LiveryRuleEntry;
  readonly members: ReadonlySet<string>;
}

export interface LiveryBook {
  /**
   * The palette row of the livery the operator runs the series in on `day` (ISO date, Europe/Berlin):
   * the best rule, the operator's own line rule first, then its own plain rule, then the plain rule
   * of the group it belongs to (a line rule never reaches the companies of a group). The neutral
   * row when the series has liveries but none for this operator and day, undefined when no rule
   * names the series (the model keeps its own row).
   */
  rowFor(trip: LiveryTrip, day: string): number | undefined;
}

const EMPTY: LiveryBook = { rowFor: () => undefined };

const BERLIN = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
let lastMinute = Number.NaN;
let lastIso = "";

/**
 * The Europe/Berlin day of Unix seconds as an ISO date (the days a livery is valid on are
 * timetable days), remembered for the next call within the same minute: zone offsets are whole
 * hours, so a day never changes inside a minute.
 */
export function dayOf(unixSeconds: number): string {
  const minute = Math.floor(unixSeconds / 60);
  if (minute !== lastMinute) {
    lastMinute = minute;
    const parts = BERLIN.formatToParts(minute * 60_000);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    lastIso = `${part("year")}-${part("month")}-${part("day")}`;
  }
  return lastIso;
}

function validOn(rule: LiveryRuleEntry, day: string): boolean {
  return (!rule.validFrom || rule.validFrom <= day) && (!rule.validTo || day <= rule.validTo);
}

function rankOf(candidate: Candidate, trip: LiveryTrip, day: string): number {
  const { rule, members } = candidate;
  const operator = trip.operator;
  if (!operator || !validOn(rule, day)) return -1;
  if (rule.operator === operator) {
    if (!rule.lines) return 1;
    return trip.line && rule.lines.includes(trip.line) ? 2 : -1;
  }
  return !rule.lines && members.has(operator) ? 0 : -1;
}

export function parseLiveryBook(manifest: LiveryManifest | undefined): LiveryBook {
  if (!manifest || manifest.rules.length === 0) return EMPTY;
  const none: ReadonlySet<string> = new Set();
  const groups = new Map(Object.entries(manifest.groups).map(([k, ids]) => [k, new Set(ids)]));
  const bySeries = new Map<string, Candidate[]>();
  for (const rule of manifest.rules) {
    const candidate = { rule, members: (rule.group && groups.get(rule.group)) || none };
    for (const series of rule.series) {
      const list = bySeries.get(series) ?? [];
      list.push(candidate);
      bySeries.set(series, list);
    }
  }
  return {
    rowFor(trip, day) {
      const candidates = trip.series ? bySeries.get(trip.series) : undefined;
      if (!candidates) return undefined;
      let best = NEUTRAL_ROW;
      let bestRank = -1;
      for (const candidate of candidates) {
        const rank = rankOf(candidate, trip, day);
        if (rank > bestRank) {
          bestRank = rank;
          best = candidate.rule.row;
        }
      }
      return best;
    },
  };
}
