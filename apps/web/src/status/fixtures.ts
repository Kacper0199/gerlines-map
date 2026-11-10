import type { DataSourceStatus, DataStatus } from "@gerlines/schema/status";

const source = (
  patch: Partial<DataSourceStatus> & Pick<DataSourceStatus, "id" | "name" | "kind">,
): DataSourceStatus => ({
  country: "DE",
  recordedAt: "2026-11-08T11:59:20.000Z",
  dataTime: "2026-11-08T11:58:40.000Z",
  staleAfterSeconds: 300,
  state: "ok",
  ...patch,
});

/** An answer of `GET /api/v1/status` at 13:00 Berlin time with every state once. */
export const STATUS_SAMPLE: DataStatus = {
  at: "2026-11-08T12:00:00.000Z",
  live: {
    confirmedAt: "2026-11-08T11:59:56.000Z",
    frameAgeSeconds: 4,
    staleAfterSeconds: 30,
    state: "ok",
  },
  sources: [
    source({
      id: "delfi-timetable",
      name: "DELFI",
      kind: "timetable",
      recordedAt: "2026-11-05T19:02:33.000Z",
      dataTime: null,
      staleAfterSeconds: null,
    }),
    source({ id: "delfi-realtime", name: "DELFI", kind: "realtime", staleAfterSeconds: 600 }),
    source({
      id: "gtfsde-realtime",
      name: "gtfs.de",
      kind: "realtime",
      recordedAt: "2026-11-08T11:50:00.000Z",
      state: "stale",
    }),
    source({
      id: "db-iris",
      name: "DB Timetables",
      kind: "iris",
      recordedAt: null,
      dataTime: null,
      staleAfterSeconds: 540,
      state: "not_recorded",
    }),
    source({
      id: "nl-ovapi",
      name: "OVapi",
      kind: "neighbours",
      country: "NL",
      staleAfterSeconds: 1200,
    }),
    source({
      id: "pl-pkpic",
      name: "PKP Intercity",
      kind: "neighbours",
      country: "PL",
      recordedAt: "2026-11-08T10:30:00.000Z",
      dataTime: null,
      staleAfterSeconds: 600,
      state: "down",
    }),
  ],
};
