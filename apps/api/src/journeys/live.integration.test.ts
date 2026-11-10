import { JOURNEY_SORTS, type Journey, JourneysResponse } from "@gerlines/schema/journeys";
import { describe, expect, it } from "vitest";
import { createApp, JOURNEYS_PATH, ROUTER_HEALTH_PATH } from "../app.ts";
import { readRouterConfig } from "../router/config.ts";
import { nextWeekdayAt } from "../router/local-time.ts";
import { createRouterClient } from "../router/motis.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import { RANKINGS } from "./rank.ts";

const TUESDAY = 2;
const config = readRouterConfig(process.env, "0.0.0");
const time = nextWeekdayAt(Date.now(), TUESDAY, 7, "Europe/Berlin");
const BERLIN = "de:11000:900003201";
const HAMBURG = "de:02000:10950";
const MUENCHEN = "de:09162:100";
const BREMEN = "de:04011:13927";
const AUGSBURG = "de:09761:100";

const transitLegs = (journey: Journey) =>
  journey.legs.flatMap((leg) => (leg.kind === "transit" ? [leg] : []));

describe.skipIf(!config)("journeys against a running MOTIS (ROUTER_BASE_URL)", () => {
  const app = config
    ? createApp({
        router: { client: createRouterClient(config), datasetTag: config.datasetTag },
        journeyLimiter: fixedWindowLimiter({ limit: 1_000, windowMs: 60_000 }),
      })
    : undefined;

  async function journeys(
    from: string,
    to: string,
    params: string,
    skip: (note: string) => void,
  ): Promise<JourneysResponse> {
    const response = await app?.request(
      `${JOURNEYS_PATH}?from=${from}&to=${to}&time=${encodeURIComponent(time)}${params}`,
    );
    if (response?.status === 422) {
      skip(`${time} is outside the timetable window MOTIS has loaded`);
    }
    expect(response?.status).toBe(200);
    return JourneysResponse.parse(await response?.json());
  }

  it("is healthy", async () => {
    const response = await app?.request(ROUTER_HEALTH_PATH);
    expect(response?.status).toBe(200);
  });

  it("finds Berlin Hbf to München Hbf with and without high-speed trains", async (context) => {
    const skip = (note: string) => context.skip(note);
    const all = await journeys(BERLIN, MUENCHEN, "", skip);
    expect(all.journeys.length).toBeGreaterThan(0);
    expect(all.journeys.some((journey) => journey.categories.includes("hsr"))).toBe(true);

    const noHsr = await journeys(
      BERLIN,
      MUENCHEN,
      "&categories=ld,night,rfast,reg,sbahn,urban,bus,other",
      skip,
    );
    expect(noHsr.journeys.length).toBeGreaterThan(0);
    expect(noHsr.removedByFilter).toBe(0);
    expect(noHsr.journeys.every((journey) => !journey.categories.includes("hsr"))).toBe(true);
  }, 60_000);

  it("leaves out FlixTrain, or DB IC, on Berlin Hbf to Hamburg Hbf", async (context) => {
    const skip = (note: string) => context.skip(note);
    const noFlx = await journeys(BERLIN, HAMBURG, "&categories=ld&exclude=flx&results=3", skip);
    const noFlxLegs = noFlx.journeys.flatMap(transitLegs);
    expect(noFlxLegs.length).toBeGreaterThan(0);
    expect(noFlxLegs.every((leg) => leg.category === "ld" && !/^FLX/.test(leg.line ?? ""))).toBe(
      true,
    );

    const noIc = await journeys(BERLIN, HAMBURG, "&categories=ld&exclude=ic&results=2", skip);
    const noIcLegs = noIc.journeys.flatMap(transitLegs);
    expect(noIcLegs.length).toBeGreaterThan(0);
    expect(noIcLegs.every((leg) => /^FLX/.test(leg.line ?? ""))).toBe(true);
  }, 60_000);

  it("keeps RE and drops RB on Bremen Hbf to Hamburg Hbf, and the other way round", async (context) => {
    const skip = (note: string) => context.skip(note);
    const re = await journeys(BREMEN, HAMBURG, "&categories=rfast", skip);
    expect(re.journeys.length).toBeGreaterThan(0);
    expect(re.journeys.flatMap(transitLegs).every((leg) => leg.category === "rfast")).toBe(true);
    expect(re.removedBy.category).toBeGreaterThan(0);

    const rb = await journeys(BREMEN, HAMBURG, "&categories=reg", skip);
    expect(rb.journeys.length).toBeGreaterThan(0);
    expect(rb.journeys.flatMap(transitLegs).every((leg) => leg.category === "reg")).toBe(true);
  }, 60_000);

  it("keeps only journeys run by the chosen operator, or none by the avoided one", async (context) => {
    const skip = (note: string) => context.skip(note);
    const only = await journeys(
      MUENCHEN,
      AUGSBURG,
      "&categories=rfast,reg,sbahn&operators=Arverio",
      skip,
    );
    expect(only.journeys.length).toBeGreaterThan(0);
    expect(
      only.journeys.flatMap(transitLegs).every((leg) => /^Arverio/.test(leg.operator ?? "")),
    ).toBe(true);

    const avoid = await journeys(
      MUENCHEN,
      AUGSBURG,
      "&categories=rfast,reg,sbahn&avoidOperators=Arverio",
      skip,
    );
    expect(
      avoid.journeys.flatMap(transitLegs).some((leg) => /^Arverio/.test(leg.operator ?? "")),
    ).toBe(false);
  }, 60_000);

  for (const sort of JOURNEY_SORTS) {
    it(`orders Berlin Hbf to München Hbf by ${sort}`, async (context) => {
      const result = await journeys(BERLIN, MUENCHEN, `&sort=${sort}`, (note) =>
        context.skip(note),
      );
      for (let index = 1; index < result.journeys.length; index += 1) {
        const pair = [result.journeys[index - 1], result.journeys[index]] as [Journey, Journey];
        expect(RANKINGS[sort](...pair)).toBeLessThan(0);
      }
      expect(result.journeys.filter((journey) => journey.tags.includes(sort))).toHaveLength(1);
    }, 60_000);
  }

  it("pages later and earlier with the cursors of an answer", async (context) => {
    const skip = (note: string) => context.skip(note);
    const first = await journeys(BERLIN, HAMBURG, "", skip);
    const departures = first.journeys.map((journey) => Date.parse(journey.departure));
    expect(first.laterCursor).toMatch(/^LATER\|/);
    expect(first.earlierCursor).toMatch(/^EARLIER\|/);

    const later = await journeys(
      BERLIN,
      HAMBURG,
      `&cursor=${encodeURIComponent(first.laterCursor ?? "")}`,
      skip,
    );
    expect(later.journeys.length).toBeGreaterThan(0);
    expect(
      Math.min(...later.journeys.map((journey) => Date.parse(journey.departure))),
    ).toBeGreaterThan(Math.max(...departures));

    const earlier = await journeys(
      BERLIN,
      HAMBURG,
      `&cursor=${encodeURIComponent(first.earlierCursor ?? "")}`,
      skip,
    );
    expect(earlier.journeys.length).toBeGreaterThan(0);
    expect(
      Math.max(...earlier.journeys.map((journey) => Date.parse(journey.departure))),
    ).toBeLessThan(Math.min(...departures));
  }, 60_000);

  it("fills up across pages when a filter removes most journeys", async (context) => {
    const result = await journeys(BERLIN, HAMBURG, "&operators=Flix&results=3", (note) =>
      context.skip(note),
    );
    expect(result.routerCalls).toBeGreaterThan(1);
    expect(result.routerCalls).toBeLessThanOrEqual(3);
    expect(
      result.journeys.flatMap(transitLegs).every((leg) => /^Flix/.test(leg.operator ?? "")),
    ).toBe(true);
  }, 60_000);

  it("finds direct trains only with maxChanges 0, and arrivals before the time with arriveBy", async (context) => {
    const skip = (note: string) => context.skip(note);
    const direct = await journeys(BERLIN, HAMBURG, "&maxChanges=0", skip);
    expect(direct.journeys.length).toBeGreaterThan(0);
    expect(direct.journeys.every((journey) => journey.transfers === 0)).toBe(true);

    const arriveBy = await journeys(BERLIN, HAMBURG, "&arriveBy=true", skip);
    expect(arriveBy.journeys.length).toBeGreaterThan(0);
    expect(arriveBy.query.sort).toBe("latestDeparture");
    expect(
      arriveBy.journeys.every((journey) => Date.parse(journey.arrival) <= Date.parse(time)),
    ).toBe(true);
  }, 60_000);
});
