import type { TrainDetail, TrainStop } from "@gerlines/schema";

export const T0 = Date.parse("2026-10-27T08:00:00Z");
export const MINUTE = 60_000;

const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

export interface StopSpec {
  readonly name: string;
  readonly arrival?: number | null;
  readonly departure?: number | null;
  readonly delay?: number | null;
  readonly platform?: string | null;
  readonly platformActual?: string | null;
  readonly cancelled?: boolean;
}

function placeId(index: number): string {
  return `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

function timed(minutes: number | null, delay: number | null) {
  if (minutes === null) {
    return { scheduled: null, predicted: null, delaySeconds: null };
  }
  return {
    scheduled: at(minutes),
    predicted: delay === null ? null : at(minutes + delay),
    delaySeconds: delay === null ? null : delay * 60,
  };
}

function arrivalMinutes(spec: StopSpec, index: number): number | null {
  return index === 0 ? null : (spec.arrival ?? null);
}

function departureMinutes(spec: StopSpec, index: number, count: number): number | null {
  return index === count - 1 ? null : (spec.departure ?? spec.arrival ?? null);
}

export function testStops(specs: readonly StopSpec[], realtime = true): TrainStop[] {
  return specs.map((spec, index) => {
    const delay = realtime ? (spec.delay ?? null) : null;
    const arrival = timed(arrivalMinutes(spec, index), delay);
    const departure = timed(departureMinutes(spec, index, specs.length), delay);
    return {
      index,
      stopPlaceId: placeId(index),
      name: spec.name,
      scheduledArrival: arrival.scheduled,
      scheduledDeparture: departure.scheduled,
      predictedArrival: arrival.predicted,
      predictedDeparture: departure.predicted,
      arrivalDelaySeconds: arrival.delaySeconds,
      departureDelaySeconds: departure.delaySeconds,
      platformScheduled: spec.platform ?? null,
      platformActual: realtime ? (spec.platformActual ?? null) : null,
      cancelled: spec.cancelled ?? false,
      prediction: delay === null ? null : "explicit",
    };
  });
}

export const FIVE_STOPS: readonly StopSpec[] = [
  { name: "Berlin Hbf", departure: 0, delay: 2, platform: "14" },
  { name: "Berlin-Spandau", arrival: 10, departure: 12, delay: 4, platform: "4" },
  { name: "Stendal Hbf", arrival: 40, departure: 42, delay: 6, platform: "7", platformActual: "8" },
  { name: "Wolfsburg Hbf", arrival: 70, departure: 72, delay: 6, platform: "2" },
  { name: "Hannover Hbf", arrival: 100, delay: 5, platform: "9" },
];

export function testDetail(overrides: Partial<TrainDetail> = {}): TrainDetail {
  const stops = overrides.stops ?? testStops(FIVE_STOPS);
  const last = stops[stops.length - 1];
  return {
    tripInstanceId: "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11",
    frameKey: 17,
    serviceDate: "2026-10-27",
    timetableVersion: "delfi-2026-10-26",
    version: 3,
    asOf: at(30),
    category: "hsr",
    productName: "ICE",
    line: "10",
    trainNumber: "541",
    foreign: false,
    added: false,
    cancelled: false,
    operator: { id: "db-fernverkehr-ag", name: "DB Fernverkehr", wikidataQid: null },
    destination: { stopPlaceId: last?.stopPlaceId ?? placeId(0), name: last?.name ?? "End" },
    headsign: null,
    delaySeconds: 360,
    provenance: {
      kind: "realtime",
      sourceId: "gtfsde-rt",
      sourceName: "gtfs.de realtime (free, beta)",
      attribution: "DELFI e.V. and GTFS.de",
      predictionChangedAt: at(28),
      feedObservedAt: at(29.5),
    },
    geometry: { available: true, reason: null },
    progress: { lastPassedIndex: 1, nextIndex: 2 },
    stops,
    vehicle: null,
    photo: null,
    ...overrides,
  };
}
