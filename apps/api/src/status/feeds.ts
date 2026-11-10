import type { DataSourceKind } from "@gerlines/schema/status";

/**
 * One source of what the map shows, as a viewer sees it: one or more recorder sources (`sources`,
 * or every recorder source whose id starts with `prefix`), the provider's own name, the country it
 * covers and the recorder's staleness threshold. Timetables have none: a file is new only when the
 * publisher changes it, and the recorder stores nothing for an unchanged one.
 */
export interface StatusFeed {
  readonly id: string;
  readonly name: string;
  readonly kind: DataSourceKind;
  readonly country: string;
  readonly sources: readonly string[];
  readonly prefix?: string;
  readonly staleAfterSeconds: number | null;
}

/**
 * The thresholds are the recorder's (`staleThresholdMs` in services/ingest/src/status.ts, `recorder
 * status`); a test compares them with a copy of its output. DB IRIS asks the full changes every
 * 3 minutes, so the recorder's rule gives max(5 min, 3 periods) = 540 s.
 */
export const STATUS_FEEDS: readonly StatusFeed[] = [
  {
    id: "delfi-timetable",
    name: "DELFI",
    kind: "timetable",
    country: "DE",
    sources: ["delfi-gtfs"],
    staleAfterSeconds: null,
  },
  {
    id: "delfi-realtime",
    name: "DELFI",
    kind: "realtime",
    country: "DE",
    sources: ["delfi-mobilithek-rt", "delfi-gtfs-rt"],
    staleAfterSeconds: 600,
  },
  {
    id: "gtfsde-realtime",
    name: "gtfs.de",
    kind: "realtime",
    country: "DE",
    sources: ["gtfsde-rt"],
    staleAfterSeconds: 300,
  },
  {
    id: "db-iris",
    name: "DB Timetables",
    kind: "iris",
    country: "DE",
    sources: [],
    prefix: "db-iris-fchg-",
    staleAfterSeconds: 540,
  },
  {
    id: "nl-ovapi",
    name: "OVapi",
    kind: "neighbours",
    country: "NL",
    sources: ["ovapi-train-updates"],
    staleAfterSeconds: 1200,
  },
  {
    id: "be-sncb",
    name: "NMBS SNCB",
    kind: "neighbours",
    country: "BE",
    sources: ["be-sncb-gtfs-rt"],
    staleAfterSeconds: 300,
  },
  {
    id: "fr-sncf",
    name: "SNCF",
    kind: "neighbours",
    country: "FR",
    sources: ["fr-sncf-gtfs-rt"],
    staleAfterSeconds: 300,
  },
  {
    id: "ch-otd",
    name: "opentransportdata.swiss",
    kind: "neighbours",
    country: "CH",
    sources: ["ch-otd-gtfs-rt"],
    staleAfterSeconds: 300,
  },
  {
    id: "cz-czptt",
    name: "CZPTT",
    kind: "neighbours",
    country: "CZ",
    sources: ["cz-czptt-gtfs-rt"],
    staleAfterSeconds: 300,
  },
  {
    id: "pl-pkpic",
    name: "PKP Intercity",
    kind: "neighbours",
    country: "PL",
    sources: ["pl-pkpic-gtfs-rt"],
    staleAfterSeconds: 600,
  },
  {
    id: "pl-trains",
    name: "mkuran.pl",
    kind: "neighbours",
    country: "PL",
    sources: ["pl-trains-gtfs-rt"],
    staleAfterSeconds: 300,
  },
];

/** Whether a recorder source belongs to the feed. */
export function feedHolds(feed: StatusFeed, source: string): boolean {
  return (
    feed.sources.includes(source) || (feed.prefix !== undefined && source.startsWith(feed.prefix))
  );
}
