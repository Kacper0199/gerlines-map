import type { SearchData, TrainRecord } from "./records.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const KOELN_HBF = id(1);
export const MUENCHEN_HBF = id(2);
export const KOELN_MESSE = id(3);
export const BERLIN_HBF = id(4);
export const GIESSEN = id(5);
export const STRALSUND_HBF = id(6);
export const SZCZECIN_GLOWNY = id(7);

function train(n: number, fields: Partial<TrainRecord>): TrainRecord {
  return {
    id: id(100 + n),
    title: "ICE 693",
    productName: "ICE",
    trainNumber: "693",
    line: null,
    category: "hsr",
    foreign: false,
    operator: "DB Fernverkehr AG",
    origin: { stopPlaceId: BERLIN_HBF, name: "Berlin Hbf" },
    destination: { stopPlaceId: MUENCHEN_HBF, name: "München Hbf" },
    departure: "2026-11-07T10:00:00.000Z",
    arrival: "2026-11-07T14:00:00.000Z",
    serviceDate: "2026-11-07",
    ...fields,
  };
}

export const ICE_693 = train(1, {});
export const RE1_EARLY = train(2, {
  title: "RE 1",
  productName: "RE",
  trainNumber: "10107",
  line: "RE1",
  category: "rfast",
  operator: "National Express",
  origin: { stopPlaceId: KOELN_HBF, name: "Köln Hbf" },
  destination: { stopPlaceId: KOELN_MESSE, name: "Köln Messe/Deutz" },
  departure: "2026-11-07T05:00:00.000Z",
  arrival: "2026-11-07T06:00:00.000Z",
});
export const RE1_NOW = train(3, {
  ...RE1_EARLY,
  id: id(103),
  trainNumber: "10111",
  departure: "2026-11-07T11:30:00.000Z",
  arrival: "2026-11-07T12:30:00.000Z",
});
export const ICE_6930 = train(4, { title: "ICE 6930", trainNumber: "6930" });

export const SEARCH_NOW_MS = Date.parse("2026-11-07T12:00:00Z");

export function testData(): SearchData {
  return {
    serviceDate: "2026-11-07",
    timetableVersion: "1",
    stations: [
      {
        id: KOELN_HBF,
        name: "Köln Hbf",
        lon: 6.9589,
        lat: 50.9431,
        eva: 8000207,
        dhid: "de:05315:11201",
        lines: ["RE1", "S11"],
        trainsToday: 900,
      },
      {
        id: KOELN_MESSE,
        name: "Köln Messe/Deutz",
        lon: 6.9748,
        lat: 50.9409,
        eva: 8003368,
        dhid: null,
        lines: ["RE1"],
        trainsToday: 500,
      },
      {
        id: MUENCHEN_HBF,
        name: "München Hbf",
        lon: 11.5583,
        lat: 48.1402,
        eva: 8000261,
        dhid: "de:09162:100",
        lines: [],
        trainsToday: 800,
      },
      {
        id: BERLIN_HBF,
        name: "Berlin Hbf",
        lon: 13.3695,
        lat: 52.5251,
        eva: 8011160,
        dhid: "de:11000:900003201",
        lines: [],
        trainsToday: 700,
      },
      {
        id: GIESSEN,
        name: "Gießen",
        lon: 8.6634,
        lat: 50.5793,
        eva: 8000124,
        dhid: null,
        lines: [],
        trainsToday: 200,
      },
      {
        id: STRALSUND_HBF,
        name: "Stralsund Hauptbahnhof",
        lon: 13.0775,
        lat: 54.3083,
        eva: 8010338,
        dhid: null,
        lines: [],
        trainsToday: 150,
      },
      {
        id: SZCZECIN_GLOWNY,
        name: "Szczecin Glowny",
        lon: 14.5509,
        lat: 53.4183,
        eva: 5100057,
        dhid: null,
        stopId: "pl:unknown:EVANR-5100057",
        lines: ["RE66"],
        trainsToday: 12,
      },
    ],
    trains: [ICE_693, RE1_EARLY, RE1_NOW, ICE_6930],
    lines: [
      {
        id: "national-express:RE1",
        line: "RE1",
        productName: "RE",
        category: "rfast",
        operator: "National Express",
        trainsToday: 60,
        bbox: [6.1, 50.7, 7.5, 51.6],
      },
    ],
    places: [
      {
        id: "land:DE-BY",
        type: "land",
        names: { en: "Bavaria", de: "Bayern", pl: "Bawaria" },
        region: null,
        landCode: "DE-BY",
        lon: 11.4,
        lat: 48.9,
        bbox: [8.97, 47.27, 13.84, 50.56],
        rank: 3,
      },
      {
        id: "town:05315000",
        type: "town",
        names: { en: "Köln", de: "Köln", pl: "Köln" },
        region: {
          en: "North Rhine-Westphalia",
          de: "Nordrhein-Westfalen",
          pl: "Nadrenia Północna-Westfalia",
        },
        landCode: null,
        lon: 6.957,
        lat: 50.938,
        bbox: null,
        rank: 2,
      },
      {
        id: "town:01056031",
        type: "town",
        names: { en: "Kölln-Reisiek", de: "Kölln-Reisiek", pl: "Kölln-Reisiek" },
        region: { en: "Schleswig-Holstein", de: "Schleswig-Holstein", pl: "Szlezwik-Holsztyn" },
        landCode: null,
        lon: 9.6976,
        lat: 53.7575,
        bbox: null,
        rank: 0,
      },
    ],
  };
}
