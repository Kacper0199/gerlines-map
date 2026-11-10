import { describe, expect, it } from "vitest";
import { parseIrisTimetable } from "./iris.ts";
import type { RequestLogLine } from "./live.ts";
import { changeShare, maxInWindow, sizeSummary } from "./report.ts";
import { parseStadaStations, type StadaStation } from "./stada.ts";
import { joinStada, summariseJoin } from "./stada-join.ts";

function line(endpoint: string, eva: number): RequestLogLine {
  return {
    api: "timetables",
    endpoint,
    eva,
    url: "",
    startedAt: "2026-10-25T23:00:00.000Z",
    durationMs: 1,
    status: 200,
    bytes: 1,
    sha256: null,
    contentType: null,
    retryAfterMs: null,
    error: null,
    file: null,
  };
}

const PLAN = `<timetable station='X'>
<s id="a"><tl c="ICE" n="1"/><ar pt="2610260010"/><dp pt="2610260012"/></s>
<s id="b"><tl c="RE" n="2"/><dp pt="2610260020"/></s>
<s id="c"><tl c="RB" n="3"/><dp pt="2610260030"/></s>
</timetable>`;
const FCHG = `<timetable station='X' eva='8000001'>
<s id="a"><ar ct="2610260015"/><dp ct="2610260017"/></s>
<s id="z"><dp ct="2610260059"/></s>
</timetable>`;
const RCHG = `<timetable station='X' eva='8000001'>
<s id="b"><dp cs="c" clt="2610260001"/></s>
<s id="a"><ar cp="5"/></s>
</timetable>`;

describe("run report", () => {
  it("counts the most requests in any rolling minute", () => {
    expect(maxInWindow([0, 1_000, 59_999, 60_000, 61_000])).toBe(3);
    expect(maxInWindow([])).toBe(0);
  });

  it("summarises payload sizes", () => {
    expect(sizeSummary([5, 1, 3])).toEqual({
      count: 3,
      min: 1,
      median: 3,
      p95: 5,
      max: 5,
      total: 9,
    });
  });

  it("shares planned calls with a later change, delay and cancellation", () => {
    const share = changeShare([
      { line: line("plan", 8000001), stops: parseIrisTimetable(PLAN, 8000001).stops },
      { line: line("fchg", 8000001), stops: parseIrisTimetable(FCHG).stops },
      { line: line("rchg", 8000001), stops: parseIrisTimetable(RCHG).stops },
    ]);
    expect(share).toMatchObject({
      plannedCalls: 3,
      callsWithRealtimeChange: 2,
      delayedAtLeastOneMinute: 1,
      cancelled: 1,
    });
    expect(share.share).toBeCloseTo(2 / 3);
    expect(share.byCategory.RB).toEqual({ planned: 1, changed: 0 });
  });
});

function station(
  stationNumber: number,
  mainEva: number | null,
  ifopt: string | null,
): StadaStation {
  const [parsed] = parseStadaStations(
    JSON.stringify({
      offset: 0,
      total: 1,
      result: [
        {
          number: stationNumber,
          name: `S${stationNumber}`,
          ifopt: ifopt ?? undefined,
          evaNumbers: mainEva === null ? [] : [{ number: mainEva, isMain: true }],
          ril100Identifiers: [],
        },
      ],
    }),
  ).stations;
  if (!parsed) throw new Error("fixture station missing");
  return parsed;
}

describe("StaDa join", () => {
  it("classifies agreement through id_map and DHID", () => {
    const ours = {
      stopPlaces: [
        { stopPlaceId: "p1", name: "One", dhid: "de:1:1", eva: 8000001 },
        { stopPlaceId: "p2", name: "Two", dhid: "de:1:2", eva: 8000009 },
        { stopPlaceId: "p3", name: "Three", dhid: "de:1:3", eva: null },
        { stopPlaceId: "p4", name: "Four", dhid: null, eva: 8000004 },
        { stopPlaceId: "p5", name: "Foreign", dhid: null, eva: 8500000 },
      ],
      evaMap: new Map([
        [8000001, "p1"],
        [8000004, "p4"],
        [8000009, "p2"],
        [8500000, "p5"],
      ]),
    };
    const stations = [
      station(1, 8000001, "de:1:1"),
      station(2, 8000002, "de:1:2"),
      station(3, 8000003, "de:1:3"),
      station(4, 8000004, null),
      station(5, 8000005, null),
      station(6, null, null),
    ];
    const rows = joinStada(stations, ours);
    expect(rows.map((row) => row.outcome)).toEqual([
      "agree",
      "differ",
      "ours-without-eva",
      "agree-by-eva-only",
      "missing",
      "missing",
    ]);
    const report = summariseJoin(stations, ours, rows);
    expect(report.outcomes.agree).toBe(1);
    expect(report.ourEvaNotInStada).toBe(2);
    expect(report.samples.differ?.[0]?.ourEva).toBe(8000009);
  });
});
