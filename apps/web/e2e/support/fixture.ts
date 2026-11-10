import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeHead } from "@gerlines/live-frame";

const DATA = fileURLToPath(new URL("../fixture/data/", import.meta.url));

export interface DwellingTrain {
  readonly key: number;
  readonly line: string | null;
  readonly trainNumber: number | null;
  readonly category: string;
  readonly dwelling: {
    readonly stopIndex: number;
    readonly lon: number;
    readonly lat: number;
  } | null;
}

const head = decodeHead(new Uint8Array(readFileSync(`${DATA}live/head`)));

function tripInstanceOf(key: number): string {
  return (
    JSON.parse(readFileSync(`${DATA}api/keys/${key}.json`, "utf8")) as { tripInstanceId: string }
  ).tripInstanceId;
}

export const FIXTURE = {
  sequence: head.sequence,
  timeBase: head.timeBase,
  frozenAt: new Date(head.timeBase * 1000 + 3000),
  trips: JSON.parse(readFileSync(`${DATA}live/trips.json`, "utf8")) as DwellingTrain[],
  city: { lon: 8.66, lat: 50.11 },
  trainCount:
    head.counts?.find((entry) => entry.metric === "running" && entry.category === null)?.count ?? 0,
  detailedKeys: {
    regional: 25706459,
    sbahn: 25705303,
    ice: 25702913,
  },
  tripInstanceIds: {
    regional: tripInstanceOf(25706459),
    sbahn: tripInstanceOf(25705303),
    ice: tripInstanceOf(25702913),
  },
} as const;
