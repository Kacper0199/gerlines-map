import { describe, expect, it, vi } from "vitest";
import { EMPTY_VIEW, parseCamera, parseUrlView, type UrlView, writeUrlView } from "./url-state.ts";
import { type SelectionSnapshot, startUrlSync } from "./url-sync.ts";

const TRAIN = "0b6c1c58-9d43-5a51-8f43-6a2f0c1d2e3f";
const OTHER_TRAIN = "1b6c1c58-9d43-5a51-8f43-6a2f0c1d2e3f";
const STATION = "4eda9b92-2ddf-5610-b59b-ed665a8b2610";

describe("url state", () => {
  it("reads train, station, Land and camera, ignoring malformed values", () => {
    expect(parseUrlView(`?train=${TRAIN.toUpperCase()}&land=de-by&map=9.5,50.94,6.96`)).toEqual({
      train: TRAIN,
      station: null,
      land: "DE-BY",
      camera: { zoom: 9.5, lat: 50.94, lon: 6.96 },
    });
    expect(parseUrlView("?train=koeln&station=x&land=DE-XX&map=99,1,1")).toEqual(EMPTY_VIEW);
    expect(parseUrlView(`?station=${STATION}`).station).toBe(STATION);
    expect(parseCamera("7,51,abc")).toBeNull();
    expect(parseCamera("7,51")).toBeNull();
  });

  it("names one selection only: a train wins over a station", () => {
    expect(parseUrlView(`?train=${TRAIN}&station=${STATION}`)).toMatchObject({
      train: TRAIN,
      station: null,
    });
  });

  it("writes the view and keeps the visit settings in place", () => {
    const view: UrlView = {
      train: null,
      station: STATION,
      land: null,
      camera: { zoom: 13, lat: 50.943, lon: 6.9587 },
    };
    expect(writeUrlView("?lang=pl&theme=light&train=old", view)).toBe(
      `?lang=pl&theme=light&station=${STATION}&map=13.00,50.94300,6.95870`,
    );
    expect(writeUrlView(`?train=${TRAIN}`, EMPTY_VIEW)).toBe("");
  });
});

function harness(
  initial: string,
  trainOfKey: (key: number) => Promise<string | null> = vi.fn(async (_key: number) => TRAIN),
  applyAs: (view: UrlView) => Partial<SelectionSnapshot> = (view) => ({
    selectedId: view.train,
    stationId: view.station,
    land: view.land,
  }),
) {
  const location = { pathname: "/", search: initial, hash: "" };
  const entries = [initial];
  let index = 0;
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
  let snapshot: SelectionSnapshot = {
    selectedId: null,
    stationId: null,
    missingStationId: null,
    land: null,
  };
  const listeners = new Set<() => void>();
  let pop: () => void = () => undefined;
  const applied: { view: UrlView; cause: string }[] = [];
  const timers: (() => void)[] = [];
  const sync = startUrlSync(
    {
      location,
      history,
      addPopListener: (listener) => {
        pop = listener;
        return () => undefined;
      },
      trainOfKey,
      setTimer: (callback) => {
        timers.push(callback);
        return () => timers.splice(timers.indexOf(callback), 1);
      },
    },
    {
      snapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      apply: (view, cause) => {
        applied.push({ view, cause });
        snapshot = { ...snapshot, ...applyAs(view) };
        for (const listener of listeners) listener();
      },
    },
  );
  return {
    location,
    history,
    entries,
    index: () => index,
    applied,
    sync,
    timers,
    select: async (next: Partial<SelectionSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
      await vi.waitFor(() => undefined);
      await Promise.resolve();
    },
    back: () => {
      index -= 1;
      location.search = entries[index] ?? "";
      pop();
    },
  };
}

describe("startUrlSync", () => {
  it("applies the address on load", () => {
    const page = harness(`?train=${TRAIN}&map=8,50,8`);
    expect(page.applied).toEqual([
      {
        view: expect.objectContaining({ train: TRAIN, camera: { zoom: 8, lat: 50, lon: 8 } }),
        cause: "load",
      },
    ]);
    expect(page.history.pushState).not.toHaveBeenCalled();
  });

  it("pushes a new entry per selection, and Back hands the earlier one back", async () => {
    const page = harness("?lang=de");
    await page.select({ selectedId: TRAIN });
    expect(page.location.search).toBe(`?lang=de&train=${TRAIN}`);
    await page.select({ selectedId: null, stationId: STATION });
    expect(page.location.search).toBe(`?lang=de&station=${STATION}`);
    expect(page.history.pushState).toHaveBeenCalledTimes(2);
    page.back();
    expect(page.applied.at(-1)).toEqual({
      view: expect.objectContaining({ train: TRAIN, station: null }),
      cause: "pop",
    });
  });

  it("does not push when the selection already is the address (after Back, or a link)", async () => {
    const page = harness(`?train=${TRAIN}`);
    await page.select({ selectedId: TRAIN });
    expect(page.history.pushState).not.toHaveBeenCalled();
  });

  it("writes a train picked on the map by its trip instance, and keeps it when its frame key replaces it", async () => {
    const trainOfKey = vi.fn(async (key: number) => (key === 42 ? OTHER_TRAIN : TRAIN));
    const page = harness("", trainOfKey);
    await page.select({ selectedId: "live:42" });
    await vi.waitFor(() => expect(page.location.search).toBe(`?train=${OTHER_TRAIN}`));
    await page.select({ selectedId: OTHER_TRAIN });
    await page.select({ selectedId: "live:42" });
    expect(page.history.pushState).toHaveBeenCalledTimes(1);
  });

  it("drops a key lookup that a newer selection overtook", async () => {
    let resolve: (value: string) => void = () => undefined;
    const trainOfKey = vi.fn(() => new Promise<string>((done) => (resolve = done)));
    const page = harness("", trainOfKey);
    void page.select({ selectedId: "live:7" });
    await page.select({ selectedId: null, stationId: STATION });
    resolve(TRAIN);
    await Promise.resolve();
    expect(page.location.search).toBe(`?station=${STATION}`);
  });

  it("replaces the current entry with the camera once the map rests", () => {
    const page = harness(`?train=${TRAIN}`);
    page.sync.cameraMoved({ zoom: 10, lat: 50, lon: 7 });
    page.sync.cameraMoved({ zoom: 11, lat: 50.5, lon: 7.25 });
    expect(page.timers).toHaveLength(1);
    page.timers[0]?.();
    expect(page.location.search).toBe(`?train=${TRAIN}&map=11.00,50.50000,7.25000`);
    expect(page.history.replaceState).toHaveBeenCalledTimes(1);
    expect(page.history.pushState).not.toHaveBeenCalled();
  });

  it("writes a Land focus as its own entry", async () => {
    const page = harness("");
    await page.select({ land: "DE-BY" });
    expect(page.location.search).toBe("?land=DE-BY");
  });

  it("never pushes for what an apply changed, even when it differs from the address", async () => {
    const page = harness(`?station=${STATION}`, undefined, () => ({ stationId: null }));
    await vi.waitFor(() => expect(page.history.replaceState).toHaveBeenCalled());
    expect(page.history.pushState).not.toHaveBeenCalled();
    expect(page.entries).toEqual([""]);
  });

  it("drops a station the address names that does not exist by replacing the entry", async () => {
    const page = harness("?lang=pl");
    await page.select({ stationId: STATION });
    expect(page.entries).toEqual(["?lang=pl", `?lang=pl&station=${STATION}`]);
    await page.select({ stationId: null, missingStationId: STATION });
    expect(page.entries).toEqual(["?lang=pl", "?lang=pl"]);
    expect(page.history.pushState).toHaveBeenCalledTimes(1);
  });

  it("still pushes when the user closes a station that loaded", async () => {
    const page = harness(`?station=${STATION}`);
    await page.select({ stationId: null });
    expect(page.entries).toEqual([`?station=${STATION}`, ""]);
  });

  it("keeps a linked train in the address when the card swaps it for its frame key, and Back still leaves", async () => {
    const page = harness(
      "?lang=de",
      vi.fn(async (key: number) => (key === 42 ? TRAIN : null)),
    );
    await page.select({ selectedId: TRAIN });
    await page.select({ selectedId: "live:42" });
    expect(page.entries).toEqual(["?lang=de", `?lang=de&train=${TRAIN}`]);
    expect(page.history.replaceState).not.toHaveBeenCalled();
    page.back();
    expect(page.applied.at(-1)).toEqual({
      view: expect.objectContaining({ train: null }),
      cause: "pop",
    });
  });

  it("keeps the address train when a failed key lookup follows that same train", async () => {
    const page = harness(
      `?train=${TRAIN}`,
      vi.fn(async () => null),
    );
    await page.select({ selectedId: "live:42" });
    expect(page.location.search).toBe(`?train=${TRAIN}`);
  });

  it("does not name the previous train for another train whose key lookup failed", async () => {
    const trainOfKey = vi.fn(async (key: number) => (key === 1 ? TRAIN : null));
    const page = harness("", trainOfKey);
    await page.select({ selectedId: "live:1" });
    await vi.waitFor(() => expect(page.location.search).toBe(`?train=${TRAIN}`));
    await page.select({ selectedId: "live:2" });
    await vi.waitFor(() => expect(page.location.search).toBe(""));
  });
});
