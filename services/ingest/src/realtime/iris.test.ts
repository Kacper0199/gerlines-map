import type { TripObservation } from "@gerlines/schema";
import { describe, expect, it } from "vitest";
import {
  adaptIris,
  IRIS_EVA_ALIASES,
  IrisChanges,
  IrisPlans,
  type IrisState,
  irisEvaAliases,
  irisRecordedSources,
  irisRecording,
  parseIrisStopId,
} from "./iris.ts";

const T0 = Date.parse("2026-10-25T22:00:00Z");
const T1 = T0 + 180_000;
const EVA = 8000105;
const ID = "-2320340282101811304-2610252045-7";

const xml = (body: string, eva: number | null = EVA) =>
  Buffer.from(
    `<timetable station="Frankfurt(Main)Hbf"${eva === null ? "" : ` eva="${eva}"`}>${body}</timetable>`,
  );

const PLAN = xml(
  `<s id="${ID}"><tl f="F" t="p" o="80" c="ICE" n="990"/>` +
    `<ar pt="2610260009" pp="9" fb="ICE 990"/><dp pt="2610260014" pp="9" fb="ICE 990"/></s>` +
    `<s id="5-2610252300-3"><tl f="N" t="p" o="800" c="RB" n="15698"/><ar pt="2610260001" pp="11"/></s>`,
  null,
);

function state(): IrisState {
  return { plans: new IrisPlans(), changes: new IrisChanges() };
}

function trips(result: ReturnType<typeof adaptIris>): TripObservation[] {
  if (!result.ok) throw new Error(result.failure.error);
  return result.events as TripObservation[];
}

describe("IRIS stop ids and recordings", () => {
  it("reads trip id, first departure in local time and stop index", () => {
    expect(parseIrisStopId(ID)).toEqual({
      tripId: "-2320340282101811304-2610252045",
      startDate: "2026-10-25",
      startTime: "20:45:00",
      index: 7,
    });
    expect(parseIrisStopId("8573811631662133764-2610252045-5")?.index).toBe(5);
  });

  it("refuses ids that are not IRIS stop ids", () => {
    for (const id of [
      "x-2610252045-1",
      "1-2613252045-1",
      "1-2610252545-1",
      "1-261025204-1",
      "1-2602302045-1",
      "1-2611312045-1",
      "",
    ]) {
      expect(parseIrisStopId(id), id).toBeNull();
    }
  });

  it("names the endpoint and station of a recorded source", () => {
    expect(irisRecording("db-iris-fchg-8000105")).toEqual({ endpoint: "fchg", eva: 8000105 });
    expect(irisRecording("db-iris-plan-8098160")).toEqual({ endpoint: "plan", eva: 8098160 });
    expect(irisRecording("db-iris-fchg-800010")).toBeNull();
    expect(irisRecording("gtfsde-rt")).toBeNull();
  });

  it("lists the full changes and plan of every cover EVA", () => {
    const sources = irisRecordedSources();
    expect(sources).toHaveLength(110);
    expect(sources).toContain("db-iris-fchg-8000152");
    expect(sources).toContain("db-iris-plan-8098262");
  });

  it("maps each meta EVA of the cover to its main station", () => {
    expect(IRIS_EVA_ALIASES.get(8098160)).toBe(8011160);
    expect(IRIS_EVA_ALIASES.get(8098261)).toBe(8000261);
    expect(IRIS_EVA_ALIASES.get(8098262)).toBe(8000261);
    expect(IRIS_EVA_ALIASES.get(8073368)).toBe(8003368);
    expect(IRIS_EVA_ALIASES.get(8070004)).toBe(8070003);
    expect(IRIS_EVA_ALIASES.has(8000105)).toBe(false);
    expect(
      irisEvaAliases([{ eva: 1, label: "meta first", role: "meta" }]).size,
      "a meta EVA before any main station has no alias",
    ).toBe(0);
  });
});

describe("IRIS adapter", () => {
  it("claims no realtime from a plan alone", () => {
    expect(trips(adaptIris(PLAN, "plan", EVA, T0, state()))).toEqual([]);
  });

  it("reads a change against the plan: times, delay, platform, label and planned times", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    const change = xml(
      `<s id="${ID}" eva="${EVA}"><ar ct="2610260019" cp="Gl. 7"/><dp ct="2610260024"/></s>`,
    );
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, s));
    expect(trip).toMatchObject({
      kind: "trip",
      source: "db-iris",
      entityId: "-2320340282101811304-2610252045",
      sourceTripId: "-2320340282101811304-2610252045",
      observedAt: T1,
      startDate: "2026-10-25",
      startTime: "20:45:00",
      trainNumber: "990",
      categoryLabel: "ICE",
      longDistance: true,
      relationship: "scheduled",
    });
    expect(trip?.stops).toEqual([
      {
        stopSequence: null,
        stop: { kind: "uic", code: EVA },
        arrival: {
          time: Date.parse("2026-10-25T23:19:00Z") / 1000,
          delaySeconds: 600,
          uncertaintySeconds: null,
        },
        departure: {
          time: Date.parse("2026-10-25T23:24:00Z") / 1000,
          delaySeconds: 600,
          uncertaintySeconds: null,
        },
        relationship: "scheduled",
        assignedStop: null,
        scheduled: {
          arrival: Date.parse("2026-10-25T23:09:00Z") / 1000,
          departure: Date.parse("2026-10-25T23:14:00Z") / 1000,
        },
        platform: { scheduled: "9", actual: "7" },
        messages: [],
      },
    ]);
  });

  it("leaves the delay open when the planned time is not known yet", () => {
    const change = xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260019"/></s>`);
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, state()));
    expect(trip?.stops[0]?.arrival?.delaySeconds).toBeNull();
    expect(trip?.trainNumber).toBeNull();
    expect(trip?.longDistance).toBeNull();
  });

  it("takes category and number from the display name when no trip label came", () => {
    const change = xml(
      `<s id="${ID}" eva="${EVA}"><ar ct="2610260210" pt="2610260106" fb="ICE 619"/></s>`,
    );
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, state()));
    expect(trip).toMatchObject({ trainNumber: "619", categoryLabel: "ICE", longDistance: null });
    expect(trip?.stops[0]?.arrival?.delaySeconds).toBe(3840);
  });

  it("does not read a line name as a train number", () => {
    const change = xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260210" fb="RE30" l="RE30"/></s>`);
    expect(trips(adaptIris(change, "fchg", EVA, T1, state()))[0]?.trainNumber).toBeNull();
  });

  it("reads cancelled stops as skipped and added stops as unscheduled", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    const change = xml(
      `<s id="${ID}" eva="${EVA}"><ar cs="c" clt="2610252200"/><dp cs="c" clt="2610252200"/></s>` +
        `<s id="9-2610260705-100" eva="${EVA}"><ar pt="2610260750" pp="11 D-G" ps="a"/>` +
        `<tl t="p" o="R0" c="ENO" n="83596"/></s>` +
        `<s id="9-2610260705-101" eva="8000152"><ar pt="2610260800" ct="2610260802" ps="a"/></s>`,
    );
    const result = trips(adaptIris(change, "fchg", EVA, T1, s));
    const ice = result.find((trip) => trip.trainNumber === "990");
    expect(ice?.stops[0]?.relationship).toBe("skipped");
    expect(ice?.stops[0]?.arrival).toBeNull();
    const added = result.find((trip) => trip.trainNumber === "83596");
    expect(added?.relationship).toBe("added");
    expect(added?.stops.map((stop) => stop.relationship)).toEqual(["unscheduled", "unscheduled"]);
    expect(added?.stops[0]?.platform).toEqual({ scheduled: "11 D-G", actual: null });
  });

  it("keeps a cancellation of only one event apart from a cancelled stop", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    const change = xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260012"/><dp cs="c"/></s>`);
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, s));
    expect(trip?.stops[0]?.relationship).toBe("scheduled");
    expect(trip?.stops[0]?.departure).toBeNull();
  });

  it("joins the stations of one trip and keeps planned-only stops apart for matching", () => {
    const s = state();
    const mannheim = xml(
      `<s id="-2320340282101811304-2610252045-6"><tl f="F" t="p" o="80" c="ICE" n="990"/>` +
        `<ar pt="2610252331"/><dp pt="2610252333"/></s>`,
      null,
    );
    adaptIris(mannheim, "plan", 8000244, T0, s);
    adaptIris(PLAN, "plan", EVA, T0, s);
    const change = xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260019"/></s>`);
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, s));
    expect(trip?.stops.map((stop) => [stop.stop, stop.relationship])).toEqual([
      [{ kind: "uic", code: EVA }, "scheduled"],
    ]);
    expect(trip?.plannedStops?.map((stop) => [stop.stop, stop.scheduled])).toEqual([
      [
        { kind: "uic", code: 8000244 },
        {
          arrival: Date.parse("2026-10-25T22:31:00Z") / 1000,
          departure: Date.parse("2026-10-25T22:33:00Z") / 1000,
        },
      ],
    ]);
  });

  it("keeps a platform change without a time change as realtime", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    const [trip] = trips(
      adaptIris(xml(`<s id="${ID}" eva="${EVA}"><ar cp="7"/></s>`), "fchg", EVA, T1, s),
    );
    expect(trip?.stops[0]).toMatchObject({
      relationship: "scheduled",
      arrival: null,
      platform: { scheduled: "9", actual: "7" },
    });
  });

  it("lets a later change answer replace what it names and keeps what it leaves out", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    adaptIris(xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260019"/></s>`), "fchg", EVA, T0, s);
    const later = xml(`<s id="${ID}" eva="${EVA}"><ar ct="2610260024"/></s>`);
    expect(trips(adaptIris(later, "fchg", EVA, T1, s))[0]?.stops[0]?.arrival?.delaySeconds).toBe(
      900,
    );
    const other = xml(`<s id="5-2610252300-3" eva="${EVA}"><ar ct="2610260003"/></s>`);
    const [rb] = trips(adaptIris(other, "fchg", EVA, T1 + 1, s));
    expect(rb?.trainNumber).toBe("15698");
    expect(s.changes.get(ID)?.arrival?.time).toBe(Date.parse("2026-10-25T23:24:00Z") / 1000);
  });

  it("collects messages once by id and leaves deleted ones out", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    const change = xml(
      `<s id="${ID}" eva="${EVA}"><m id="h1" t="h" cat="BAUARBEITEN" pr="1" from="2610220944" to="2611090200"/>` +
        `<m id="h2" t="h" del="1"/>` +
        `<ar ct="2610260019"><m id="d1" t="d" c="47" ts="2610252129"/></ar>` +
        `<dp ct="2610260024"><m id="d1" t="d" c="47" ts="2610252129"/></dp></s>`,
    );
    const [trip] = trips(adaptIris(change, "fchg", EVA, T1, s));
    expect(trip?.messages?.map((message) => message.id)).toEqual(["h1", "d1"]);
    expect(trip?.messages?.[1]).toEqual({
      id: "d1",
      kind: "d",
      code: 47,
      category: null,
      priority: null,
      timestamp: Date.parse("2026-10-25T20:29:00Z") / 1000,
      validFrom: null,
      validTo: null,
    });
  });

  it("emits nothing for a stop that only carries messages", () => {
    const change = xml(`<s id="${ID}" eva="${EVA}"><m id="h1" t="h" cat="BAUARBEITEN"/></s>`);
    expect(trips(adaptIris(change, "fchg", EVA, T1, state()))).toEqual([]);
  });

  it("reports an answer it cannot read as a failure", () => {
    const result = adaptIris(Buffer.from("<html>busy</html>"), "fchg", EVA, T1, state());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.source).toBe("db-iris");
  });

  it("forgets trips that started before a day", () => {
    const s = state();
    adaptIris(PLAN, "plan", EVA, T0, s);
    expect(s.plans.size).toBe(2);
    s.plans.dropBefore("2026-10-26");
    expect(s.plans.size).toBe(0);
    expect(s.plans.labelOf("-2320340282101811304-2610252045")).toBeNull();
  });
});
