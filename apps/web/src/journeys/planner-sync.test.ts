import { describe, expect, it } from "vitest";
import { createPanelStore } from "../state/panel-store.ts";
import { FIXTURES } from "./fixtures.ts";
import { createPlannerStore, type PlannerStation } from "./planner-store.ts";
import { startPlannerSync } from "./planner-sync.ts";

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
const STATIONS = new Map([BREMEN, HAMBURG].map((station) => [station.id, station]));

function browser(search: string) {
  const entries: string[] = [search];
  let index = 0;
  const pops: (() => void)[] = [];
  const location = { pathname: "/", hash: "", search };
  const go = (to: number) => {
    if (to < 0 || to >= entries.length) return;
    index = to;
    location.search = entries[index] as string;
    for (const pop of pops) pop();
  };
  const history = {
    pushState: (_: unknown, __: string, url: string) => {
      entries.splice(index + 1);
      entries.push(new URL(url, "http://x").search);
      index = entries.length - 1;
      location.search = entries[index] as string;
    },
    replaceState: (_: unknown, __: string, url: string) => {
      entries[index] = new URL(url, "http://x").search;
      location.search = entries[index] as string;
    },
  };
  return {
    entries,
    location,
    back: () => go(index - 1),
    forward: () => go(index + 1),
    environment: {
      location,
      history,
      addPopListener: (listener: () => void) => {
        pops.push(listener);
        return () => undefined;
      },
      loadStation: async (id: string) => STATIONS.get(id) ?? null,
    },
  };
}

function planner() {
  const panel = createPanelStore();
  const searches: string[] = [];
  const store = createPlannerStore({
    panel,
    fetch: async (input: string) => {
      if (input.includes("/reliability")) return Response.json(FIXTURES.reliabilityBremenHamburg);
      searches.push(input);
      return Response.json(FIXTURES.bremenHamburg);
    },
  });
  return { panel, store, searches };
}

function plannerStore() {
  return planner().store;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("planner address sync", () => {
  it("restores a linked search and shows the linked journey", async () => {
    const third = FIXTURES.bremenHamburg.journeys[2]?.id as string;
    const page = browser(
      `?lang=de&plan=1&jfrom=${BREMEN.id}&jto=${HAMBURG.id}&jtime=2026-11-10T07:00&jsel=${third}`,
    );
    const store = plannerStore();
    startPlannerSync(page.environment, store);
    await settle();
    await settle();
    const state = store.getState();
    expect(state.open).toBe(true);
    expect(state.from?.name).toBe("Bremen Hbf");
    expect(state.time).toBe("2026-11-10T07:00");
    expect(state.selectedId).toBe(third);
    expect(page.entries).toHaveLength(1);
    expect(page.location.search).toContain(`jsel=${third}`);
    expect(page.location.search).toContain("lang=de");
  });

  it("keeps a linked address intact while it is applied, also when the sync starts twice", async () => {
    const link = `?plan=1&jfrom=${BREMEN.id}&jto=${HAMBURG.id}&jtime=2026-11-10T07:00`;
    const page = browser(link);
    const store = plannerStore();
    const stop = startPlannerSync(page.environment, store);
    expect(page.location.search).toBe(link);
    stop();
    startPlannerSync(page.environment, store);
    await settle();
    await settle();
    expect(store.getState().from?.id).toBe(BREMEN.id);
    expect(store.getState().time).toBe("2026-11-10T07:00");
    expect(page.location.search).toContain(`jfrom=${BREMEN.id}`);
    expect(page.location.search).toContain("jsel=");
    expect(page.entries).toHaveLength(1);
  });

  it("adds an entry per search and replaces it when another journey is picked", async () => {
    const page = browser("?lang=en");
    const store = plannerStore();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    expect(page.location.search).toBe("?lang=en&plan=1");
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    expect(page.entries).toHaveLength(3);
    const second = FIXTURES.bremenHamburg.journeys[1]?.id as string;
    store.getState().select(second);
    expect(page.entries).toHaveLength(3);
    expect(page.location.search).toContain(`jsel=${second}`);
  });

  it("closes on Back to an address without the planner", async () => {
    const page = browser("");
    const store = plannerStore();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    page.back();
    await settle();
    expect(store.getState().open).toBe(false);
  });

  it("goes back from a search to the opened planner without results and keeps that entry", async () => {
    const page = browser("?lang=en");
    const store = plannerStore();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    page.back();
    await settle();
    await settle();
    expect(page.location.search).toBe("?lang=en&plan=1");
    expect(store.getState()).toMatchObject({ open: true, searched: null, selectedId: null });
    expect(store.getState().results.status).toBe("idle");
  });

  it("goes back to the previous search", async () => {
    const page = browser("");
    const store = plannerStore();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    store.getState().setFrom(HAMBURG);
    store.getState().setTo(BREMEN);
    await store.getState().search();
    page.back();
    await settle();
    await settle();
    expect(store.getState().from?.id).toBe(BREMEN.id);
    expect(store.getState().searched?.from).toBe(BREMEN.id);
  });

  it("keeps the search in the address while statistics hold the slot and brings it back with its journey", async () => {
    const page = browser("?lang=en");
    const { store, panel, searches } = planner();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    const second = FIXTURES.bremenHamburg.journeys[1]?.id as string;
    store.getState().select(second);
    panel.getState().open("stats");
    expect(page.location.search).not.toContain("plan=1");
    expect(page.location.search).toContain(`jfrom=${BREMEN.id}`);
    expect(page.location.search).toContain(`jto=${HAMBURG.id}`);
    expect(page.location.search).toContain(`jsel=${second}`);
    store.getState().openPlanner();
    expect(page.location.search).toContain("plan=1");
    expect(page.location.search).toContain(`jsel=${second}`);
    expect(store.getState()).toMatchObject({ open: true, selectedId: second });
    expect(store.getState().results.status).toBe("ready");
    expect(searches).toHaveLength(1);
  });

  it("goes Back from statistics to the planner with its results and Forward sets it aside again", async () => {
    const page = browser("");
    const { store, panel } = planner();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    panel.getState().open("stats");
    const aside = page.location.search;
    page.back();
    await settle();
    expect(store.getState().open).toBe(true);
    expect(store.getState().results.status).toBe("ready");
    page.forward();
    await settle();
    expect(store.getState().open).toBe(false);
    expect(store.getState().results.status).toBe("ready");
    expect(page.location.search).toBe(aside);
  });

  it("after a reload with the planner set aside, opens it on the linked search and journey", async () => {
    const third = FIXTURES.bremenHamburg.journeys[2]?.id as string;
    const link = `?lang=de&jfrom=${BREMEN.id}&jto=${HAMBURG.id}&jtime=2026-11-10T07:00&jsel=${third}`;
    const page = browser(link);
    const { store, searches } = planner();
    startPlannerSync(page.environment, store);
    await settle();
    await settle();
    expect(store.getState().open).toBe(false);
    expect(page.location.search).toBe(link);
    expect(searches).toHaveLength(0);
    store.getState().openPlanner();
    await settle();
    await settle();
    const state = store.getState();
    expect(state).toMatchObject({ open: true, selectedId: third, time: "2026-11-10T07:00" });
    expect(state.from?.name).toBe("Bremen Hbf");
    expect(page.location.search).toContain("plan=1");
    expect(page.location.search).toContain(`jsel=${third}`);
    expect(page.entries).toHaveLength(2);
  });

  it("drops the set aside search from the address when the planner is closed for good", async () => {
    const page = browser("?lang=en");
    const { store, panel } = planner();
    startPlannerSync(page.environment, store);
    store.getState().openPlanner();
    store.getState().setFrom(BREMEN);
    store.getState().setTo(HAMBURG);
    await store.getState().search();
    panel.getState().open("stats");
    store.getState().reset();
    expect(page.location.search).toBe("?lang=en");
  });
});
