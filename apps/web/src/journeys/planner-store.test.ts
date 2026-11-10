import { describe, expect, it } from "vitest";
import { createPanelStore } from "../state/panel-store.ts";
import { FIXTURES } from "./fixtures.ts";
import { createPlannerStore, type PlannerStation, selectedJourney } from "./planner-store.ts";

const BREMEN: PlannerStation = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Bremen Hbf",
  stopId: "de:04011:13927",
  lon: 8.81,
  lat: 53.08,
};
const HAMBURG: PlannerStation = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Hamburg Hbf",
  stopId: "de:02000:10950",
  lon: 10.0,
  lat: 53.55,
};

interface Call {
  readonly url: URL;
}

function api(answers: { journeys?: (url: URL) => Response; reliability?: (url: URL) => Response }) {
  const calls: Call[] = [];
  const fetch = async (input: string) => {
    const url = new URL(input, "http://local");
    calls.push({ url });
    if (url.pathname.endsWith("/reliability")) {
      return answers.reliability?.(url) ?? Response.json(FIXTURES.reliabilityBremenHamburg);
    }
    return (
      answers.journeys?.(url) ??
      Response.json(
        url.searchParams.get("cursor")?.startsWith("LATER")
          ? FIXTURES.bremenHamburgLater
          : FIXTURES.bremenHamburg,
      )
    );
  };
  const panel = createPanelStore();
  return { calls, panel, store: createPlannerStore({ fetch, panel }) };
}

function ready(store: ReturnType<typeof api>["store"]) {
  const results = store.getState().results;
  if (results.status !== "ready") throw new Error(`results are ${results.status}`);
  return results;
}

describe("planner store", () => {
  it("refuses to search without two different stations with stop ids, or without trains", async () => {
    const { store, calls } = api({});
    await store.getState().search();
    expect(store.getState().problem).toBe("stations");
    store.getState().setFrom(BREMEN);
    store.getState().setTo(BREMEN);
    await store.getState().search();
    expect(store.getState().problem).toBe("same");
    store.getState().setTo({ ...HAMBURG, stopId: null });
    await store.getState().search();
    expect(store.getState().problem).toBe("noStopId");
    store.getState().setTo(HAMBURG);
    for (const category of store.getState().categories) store.getState().toggleCategory(category);
    await store.getState().search();
    expect(store.getState().problem).toBe("categories");
    expect(calls).toHaveLength(0);
  });

  it("searches to a station abroad by the feed stop id the search answered", async () => {
    const { store, calls } = api({});
    store.getState().setFrom(BREMEN);
    store.getState().setTo({
      id: "7d062e86-a7af-5199-98c3-b2b62cd9b516",
      name: "Basel SBB",
      stopId: "ch:1:sloid:10",
      lon: 7.5895,
      lat: 47.5476,
    });
    await store.getState().search();
    expect(store.getState().problem).toBeNull();
    expect(calls[0]?.url.searchParams.get("to")).toBe("ch:1:sloid:10");
  });

  it("searches with the stop ids and the Berlin time, shows the first journey, then loads punctuality", async () => {
    const { store, calls } = api({});
    const state = store.getState();
    state.setFrom(BREMEN);
    state.setTo(HAMBURG);
    state.setTime("2026-11-10T07:00");
    await state.search();
    const journeysCall = calls[0]?.url;
    expect(journeysCall?.searchParams.get("from")).toBe("de:04011:13927");
    expect(journeysCall?.searchParams.get("time")).toBe("2026-11-10T06:00:00.000Z");
    expect(journeysCall?.searchParams.get("categories")).toBeNull();
    const results = ready(store);
    expect(results.journeys).toHaveLength(5);
    expect(store.getState().selectedId).toBe(results.journeys[0]?.id);
    expect(store.getState().searched).toMatchObject({
      open: true,
      from: BREMEN.id,
      to: HAMBURG.id,
      time: "2026-11-10T07:00",
      categories: null,
    });
    expect(calls[1]?.url.searchParams.getAll("train")).toContain("hsr~001028~DB Fernverkehr AG");
    expect(store.getState().reliability.get("hsr~001028~DB Fernverkehr AG")).toMatchObject({
      status: "known",
      runs: 2,
    });
  });

  it("keeps the journey a link names when the search finds it", async () => {
    const { store } = api({});
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    const third = FIXTURES.bremenHamburg.journeys[2]?.id as string;
    await store.getState().search({ select: third });
    expect(selectedJourney(store.getState())?.id).toBe(third);
    await store.getState().search({ select: "ffffffffffffffff" });
    expect(store.getState().selectedId).toBe(FIXTURES.bremenHamburg.journeys[0]?.id);
  });

  it("sends only the chosen categories and the operator", async () => {
    const { store, calls } = api({});
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    store.getState().toggleCategory("hsr");
    store.getState().toggleCategory("ld");
    store.getState().setOperator("  metronom ");
    await store.getState().search();
    expect(calls[0]?.url.searchParams.get("categories")).toBe("night,rfast,reg,sbahn");
    expect(calls[0]?.url.searchParams.get("operators")).toBe("metronom");
    expect(store.getState().searched?.operator).toBe("metronom");
  });

  it("adds later journeys after the shown ones with the same query", async () => {
    const { store, calls } = api({});
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    store.getState().setTime("2026-11-10T07:00");
    await store.getState().search();
    store.getState().setTime("2026-11-11T09:00");
    await store.getState().page("later");
    const page = calls.find((call) => call.url.searchParams.has("cursor"))?.url;
    expect(page?.searchParams.get("cursor")).toBe(FIXTURES.bremenHamburg.laterCursor);
    expect(page?.searchParams.get("time")).toBeNull();
    const results = ready(store);
    expect(results.journeys.length).toBeGreaterThan(5);
    expect(results.laterCursor).toBe(FIXTURES.bremenHamburgLater.laterCursor);
    expect(results.earlierCursor).toBe(FIXTURES.bremenHamburg.earlierCursor);
  });

  it("keeps the shown journeys when a page fails and says so", async () => {
    let fail = false;
    const { store } = api({
      journeys: () =>
        fail
          ? Response.json({ error: "router_busy" }, { status: 503 })
          : Response.json(FIXTURES.bremenHamburg),
    });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    fail = true;
    await store.getState().page("earlier");
    expect(ready(store)).toMatchObject({ paging: null, pageError: "busy" });
    expect(ready(store).journeys).toHaveLength(5);
  });

  it("shows the error of a failed search", async () => {
    const { store } = api({
      journeys: () => Response.json({ error: "stop_not_found" }, { status: 404 }),
    });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    expect(store.getState().results).toEqual({ status: "error", error: "stop" });
  });

  it("marks punctuality unavailable for every train when that request fails", async () => {
    const { store } = api({
      reliability: () => Response.json({ error: "stats_unavailable" }, { status: 503 }),
    });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    const entries = [...store.getState().reliability.values()];
    expect(entries.length).toBeGreaterThan(0);
    expect(
      entries.every((entry) => entry.status === "missing" && entry.reason === "unavailable"),
    ).toBe(true);
  });

  it("drops the answer of an older search", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (input: string) => {
      const url = new URL(input, "http://local");
      if (url.pathname.endsWith("/reliability"))
        return Response.json(FIXTURES.reliabilityBremenHamburg);
      if (url.searchParams.get("from") === "de:04011:13927") {
        await gate;
        return Response.json(FIXTURES.bremenHamburg);
      }
      return Response.json(FIXTURES.berlinMuenchen);
    };
    const store = createPlannerStore({ fetch, panel: createPanelStore() });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    const older = store.getState().search();
    store.getState().setFrom({
      ...BREMEN,
      id: "33333333-3333-4333-8333-333333333333",
      stopId: "de:11000:900003201",
    });
    await store.getState().search();
    release();
    await older;
    expect(ready(store).journeys[0]?.legs[0]?.from.name).toBe("S+U Berlin Hauptbahnhof");
  });

  it("closes with nothing shown", async () => {
    const { store } = api({});
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    store.getState().closePlanner();
    expect(store.getState()).toMatchObject({
      open: false,
      selectedId: null,
      results: { status: "idle" },
    });
    expect(store.getState().from).toEqual(BREMEN);
  });

  it("takes the shared slot: opening the planner closes statistics, and statistics set it aside with its search", async () => {
    const { store, panel, calls } = api({});
    panel.getState().open("stats");
    store.getState().openPlanner();
    expect(panel.getState().active).toBe("journeys");
    expect(store.getState().open).toBe(true);
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    const second = ready(store).journeys[1]?.id as string;
    store.getState().select(second);
    const asked = calls.length;
    panel.getState().open("stats");
    expect(store.getState()).toMatchObject({ open: false, selectedId: second });
    expect(store.getState().searched?.from).toBe(BREMEN.id);
    expect(ready(store).journeys.length).toBeGreaterThan(1);
    store.getState().openPlanner();
    expect(panel.getState().active).toBe("journeys");
    expect(store.getState()).toMatchObject({ open: true, selectedId: second });
    expect(calls).toHaveLength(asked);
  });

  it("sets itself aside with its search, as when another panel takes the slot", async () => {
    const { store, panel } = api({});
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    store.getState().setAside();
    expect(panel.getState()).toMatchObject({ active: null, returnTo: null });
    expect(store.getState().open).toBe(false);
    expect(ready(store).journeys.length).toBeGreaterThan(0);
    store.getState().closePlanner();
    expect(store.getState().results.status).toBe("ready");
  });

  it("forgets a search it set aside when it is reset", async () => {
    const { store, panel } = api({});
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    panel.getState().open("stats");
    store.getState().reset();
    expect(store.getState()).toMatchObject({ open: false, searched: null, from: null });
  });

  it("stays open with its journey while a train or station card holds the slot", async () => {
    const { store, panel } = api({});
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    const shown = store.getState().selectedId;
    panel.getState().suspend();
    expect(panel.getState()).toMatchObject({ active: null, returnTo: "journeys" });
    expect(store.getState()).toMatchObject({ open: true, selectedId: shown });
    store.getState().openPlanner();
    expect(panel.getState()).toMatchObject({ active: null, returnTo: "journeys" });
    panel.getState().resume();
    expect(panel.getState().active).toBe("journeys");
    expect(store.getState().selectedId).toBe(shown);
  });

  it("closing gives the slot back, also while a card holds it", () => {
    const { store, panel } = api({});
    store.getState().openPlanner();
    panel.getState().suspend();
    store.getState().closePlanner();
    expect(panel.getState()).toMatchObject({ active: null, returnTo: null });
    expect(store.getState().open).toBe(false);
  });

  it("asks again for trains whose punctuality was unavailable", async () => {
    let failing = true;
    const { store, calls } = api({
      reliability: () =>
        failing
          ? Response.json({ error: "stats_unavailable" }, { status: 503 })
          : Response.json(FIXTURES.reliabilityBremenHamburg),
    });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    failing = false;
    await store.getState().search();
    const asked = calls.filter((call) => call.url.pathname.endsWith("/reliability"));
    expect(asked).toHaveLength(2);
    expect(
      [...store.getState().reliability.values()].some((entry) => entry.status === "known"),
    ).toBe(true);
  });

  it("never leaves trains loading when a newer search or a close comes first", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (input: string) => {
      const url = new URL(input, "http://local");
      if (url.pathname.endsWith("/reliability")) {
        await gate;
        return Response.json(FIXTURES.reliabilityBremenHamburg);
      }
      return Response.json(FIXTURES.bremenHamburg);
    };
    const store = createPlannerStore({ fetch, panel: createPanelStore() });
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    const first = store.getState().search();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.getState().closePlanner();
    release();
    await first;
    const entries = [...store.getState().reliability.values()];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.status === "loading")).toBe(false);
  });

  it("asks for punctuality in groups of 30 trains", async () => {
    const template = FIXTURES.bremenHamburg.journeys[0];
    if (!template) throw new Error("fixture has no journey");
    const many = Array.from({ length: 35 }, (_, index) => ({
      ...template,
      id: index.toString(16).padStart(16, "0"),
      departure: new Date(Date.parse(template.departure) + index * 60_000).toISOString(),
      legs: template.legs.map((leg) =>
        leg.kind === "transit" ? { ...leg, tripNumber: String(9000 + index) } : leg,
      ),
    }));
    const { store, calls } = api({
      journeys: () => Response.json({ ...FIXTURES.bremenHamburg, journeys: many }),
      reliability: (url) =>
        Response.json({
          ...FIXTURES.reliabilityBremenHamburg,
          trains: url.searchParams.getAll("train").map((key) => {
            const [category, number] = key.split("~");
            return {
              status: "missing",
              category,
              number,
              operator: null,
              reason: "no_observations",
            };
          }),
        }),
    });
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    const asked = calls.filter((call) => call.url.pathname.endsWith("/reliability"));
    expect(asked.map((call) => call.url.searchParams.getAll("train").length)).toEqual([30, 5]);
    const entries = [...store.getState().reliability.values()];
    expect(entries).toHaveLength(35);
    expect(
      entries.every((entry) => entry.status === "missing" && entry.reason === "no_observations"),
    ).toBe(true);
  });

  it("widens a search left empty by its filters to every train and operator", async () => {
    const { store, calls } = api({});
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    store.getState().toggleCategory("hsr");
    store.getState().setOperator("metronom");
    await store.getState().widen();
    expect(store.getState().categories).toHaveLength(6);
    expect(store.getState().operator).toBe("");
    const asked = calls.find((call) => !call.url.pathname.endsWith("/reliability"))?.url;
    expect(asked?.searchParams.get("categories")).toBeNull();
    expect(asked?.searchParams.get("operators")).toBeNull();
  });
});
