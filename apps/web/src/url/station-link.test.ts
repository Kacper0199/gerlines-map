import type { SearchStation } from "@gerlines/schema/search";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StationFetch } from "../search/search-client.ts";
import { resetPlaceStore, usePlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { type ApplyStores, applyView, loadStation } from "./apply-view.ts";
import { storeTarget } from "./store-target.ts";
import { startUrlSync, type UrlSync } from "./url-sync.ts";

const STATION = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";
const KOELN: SearchStation = {
  kind: "station",
  id: STATION,
  name: "Köln Hbf",
  lon: 6.958729,
  lat: 50.94303,
  eva: 8000207,
  dhid: "de:05315:11201",
  lines: ["RE1"],
  trainsToday: 1207,
};

function browserLike(initial: string) {
  const location = { pathname: "/", search: initial, hash: "" };
  const entries = [initial];
  let index = 0;
  let pop: () => void = () => undefined;
  const history = {
    pushState: vi.fn((_data: unknown, _unused: string, url: string) => {
      location.search = url.slice(1);
      entries.splice(index + 1, entries.length, location.search);
      index += 1;
    }),
    replaceState: vi.fn((_data: unknown, _unused: string, url: string) => {
      location.search = url.slice(1);
      entries[index] = location.search;
    }),
  };
  return {
    location,
    history,
    entries,
    index: () => index,
    addPopListener: (listener: () => void) => {
      pop = listener;
      return () => undefined;
    },
    back() {
      index -= 1;
      location.search = entries[index] ?? "";
      pop();
    },
    forward() {
      index += 1;
      location.search = entries[index] ?? "";
      pop();
    },
  };
}

let running: UrlSync | undefined;

function start(initial: string, answers: StationFetch[]) {
  const browser = browserLike(initial);
  const fetchStation = vi.fn(async () => answers.shift() ?? { kind: "error" as const });
  const stores: ApplyStores = {
    app: () => useAppStore.getState(),
    place: () => usePlaceStore.getState(),
    knownTrainOfKey: () => null,
    fetchStation,
    fetch: vi.fn(),
  };
  running = startUrlSync(
    {
      location: browser.location,
      history: browser.history,
      addPopListener: browser.addPopListener,
      trainOfKey: async () => null,
      setTimer: () => () => undefined,
    },
    storeTarget((view, cause) => applyView(view, cause, stores)),
  );
  return { browser, stores, fetchStation };
}

const settle = () => vi.waitFor(() => undefined).then(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  useAppStore.setState(initialState());
  resetPlaceStore();
});
afterEach(() => running?.stop());

describe("a station link that fails to load", () => {
  it("keeps the address and the history when the station cannot be loaded, and Back leaves", async () => {
    const page = start("", [{ kind: "error" }, { kind: "error" }]);
    usePlaceStore.getState().selectStation({ ...KOELN });
    await settle();
    expect(page.browser.entries).toEqual(["", `?station=${STATION}`]);
    usePlaceStore.getState().selectStation(null);
    await settle();
    expect(page.browser.entries).toHaveLength(3);
    page.browser.back();
    await settle();
    expect(usePlaceStore.getState().missingStation).toEqual({ id: STATION, reason: "error" });
    expect(page.browser.entries).toHaveLength(3);
    expect(page.browser.index()).toBe(1);
    page.browser.back();
    await settle();
    expect(page.browser.index()).toBe(0);
    expect(usePlaceStore.getState().missingStation).toBeNull();
    page.browser.forward();
    await settle();
    expect(page.browser.entries).toEqual(["", `?station=${STATION}`, ""]);
    expect(page.browser.history.pushState).toHaveBeenCalledTimes(2);
  });

  it("shows a station that does not exist as not found and drops it from the address by replace", async () => {
    const page = start(`?lang=de&station=${STATION}`, [{ kind: "not-found" }]);
    await settle();
    expect(usePlaceStore.getState().missingStation).toEqual({ id: STATION, reason: "not-found" });
    expect(page.browser.entries).toEqual(["?lang=de"]);
    expect(page.browser.history.pushState).not.toHaveBeenCalled();
  });

  it("loads the station on Try again, and flies there only for a link", async () => {
    const page = start(`?station=${STATION}`, [{ kind: "error" }, { kind: "ok", station: KOELN }]);
    await settle();
    expect(usePlaceStore.getState().missingStation?.reason).toBe("error");
    expect(usePlaceStore.getState().camera).toBeNull();
    loadStation(STATION, { fly: true }, page.stores);
    expect(usePlaceStore.getState().missingStation?.id).toBe(STATION);
    await settle();
    expect(usePlaceStore.getState().station?.name).toBe("Köln Hbf");
    expect(usePlaceStore.getState().missingStation).toBeNull();
    expect(usePlaceStore.getState().camera?.target.kind).toBe("point");
    expect(page.browser.entries).toEqual([`?station=${STATION}`]);
    expect(page.fetchStation).toHaveBeenCalledTimes(2);
  });
});
