import type { TrainDetail, TrainPhoto, VehicleIdentity } from "@gerlines/schema";
import { TRAIN_FIXTURES } from "../fixtures/index.ts";
import { STALE_AFTER_MS } from "../model.ts";

export type Reply = "detail" | "loading" | "not-found" | "error" | "refresh-error";

export interface CardStateSpec {
  readonly name: string;
  readonly reply: Reply;
  readonly fixture: string;
  readonly feedAgeMs?: number;
  readonly stopsOpen?: boolean;
  readonly station?: "next" | "longest";
  readonly vehicle?: VehicleIdentity;
}

/** The identity the resolver gives ICE line 42 (fleet rule ice-line-42, a single series at L2). */
const LINE_42_VEHICLE: VehicleIdentity = {
  seriesId: "db-412",
  seriesName: "ICE 4",
  variant: null,
  units: null,
  cars: null,
  lengthMetres: null,
  layer: "L2",
  confidence: 0.8,
  source: "wikipedia-de-ice-linien",
  sourceName: "Wikipedia (de), Liste der Intercity-Express-Linien",
};

export const PRIMARY_FIXTURE = "ice-delay";

const FIXTURE_STATES: readonly CardStateSpec[] = [
  "ice-delay",
  "platform-change",
  "re-timetable",
  "sbahn-on-time",
  "cancelled-stop",
  "cancelled-train",
  "long-names",
  "foreign",
  "night",
].map((name) => ({ name, reply: "detail", fixture: name }));

export const CARD_STATES: readonly CardStateSpec[] = [
  ...FIXTURE_STATES,
  { name: "all-stops", reply: "detail", fixture: PRIMARY_FIXTURE, stopsOpen: true },
  { name: "cancelled-stop-all", reply: "detail", fixture: "cancelled-stop", stopsOpen: true },
  {
    name: "stale",
    reply: "detail",
    fixture: PRIMARY_FIXTURE,
    feedAgeMs: STALE_AFTER_MS + 60_000,
  },
  { name: "refresh-failed", reply: "refresh-error", fixture: "sbahn-on-time" },
  { name: "ends-early-all", reply: "detail", fixture: "cancelled-stop", stopsOpen: true },
  { name: "station", reply: "detail", fixture: "platform-change", station: "next" },
  { name: "long-station", reply: "detail", fixture: "long-names", station: "longest" },
  { name: "long-names-all", reply: "detail", fixture: "long-names", stopsOpen: true },
  {
    name: "vehicle-photo",
    reply: "detail",
    fixture: PRIMARY_FIXTURE,
    stopsOpen: true,
    vehicle: LINE_42_VEHICLE,
  },
  { name: "loading", reply: "loading", fixture: PRIMARY_FIXTURE },
  { name: "not-found", reply: "not-found", fixture: PRIMARY_FIXTURE },
  { name: "error", reply: "error", fixture: PRIMARY_FIXTURE },
];

export function availableStates(): CardStateSpec[] {
  return CARD_STATES.filter((spec) => spec.fixture in TRAIN_FIXTURES);
}

export function stationIndex(spec: CardStateSpec, detail: TrainDetail): number | undefined {
  if (spec.station === "next") {
    return detail.progress.nextIndex ?? undefined;
  }
  if (spec.station === "longest") {
    return [...detail.stops].sort((a, b) => b.name.length - a.name.length)[0]?.index;
  }
  return undefined;
}

export function dataTimeOf(detail: TrainDetail): number {
  return Date.parse(detail.provenance.feedObservedAt ?? detail.asOf);
}

export function detailFor(
  spec: CardStateSpec,
  detail: TrainDetail,
  photo: TrainPhoto | null = null,
): TrainDetail {
  const identified = spec.vehicle ? { ...detail, vehicle: spec.vehicle, photo } : detail;
  return spec.feedAgeMs === undefined
    ? identified
    : { ...identified, asOf: new Date(dataTimeOf(detail) + spec.feedAgeMs).toISOString() };
}

export function nowFor(detail: TrainDetail): number {
  return Date.parse(detail.asOf);
}

export function fakeTrainServer(reply: Reply, detail: TrainDetail) {
  return async (_input: string, init?: RequestInit): Promise<Response> => {
    const refresh = new Headers(init?.headers).has("if-none-match");
    if (reply === "refresh-error" && refresh) {
      return new Response(null, { status: 503 });
    }
    if (reply === "loading") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    if (reply === "not-found") {
      return new Response(null, { status: 404 });
    }
    if (reply === "error") {
      return new Response(null, { status: 503 });
    }
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: `"${detail.timetableVersion}.${detail.version}"`,
      },
    });
  };
}
