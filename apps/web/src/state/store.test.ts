// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTripCache, seedTripOfKey, useTripOfKey } from "../hooks/use-frame-trip.ts";
import type { DataStatus, LiveSelectionInfo, SelectionStops } from "../motion/protocol.ts";
import { initialState, useAppStore } from "./store.ts";

const stopsOf = (...vertices: number[]): SelectionStops => ({
  vertices: Float32Array.from(vertices),
  firstStop: 0,
  arrivals: new Float64Array(0),
  departures: new Float64Array(0),
  cancelled: new Uint8Array(0),
});

const LIVE_INFO: LiveSelectionInfo = {
  key: 5,
  line: "RE 1",
  trainNumber: 4711,
  category: "reg",
  foreign: false,
  realtime: true,
  delaySeconds: 120,
  dataTimeMs: 1,
  speedMps: null,
};

const STATUS: DataStatus = {
  state: "live",
  dataTimeMs: 1,
  trips: 3,
  realtime: 2,
  untracked: 0,
  counts: { hsr: 1, ld: 0, night: 0, rfast: 1, reg: 1, sbahn: 0, foreign: 0 },
  error: undefined,
};

describe("time line restart", () => {
  const status = (timelineEpoch?: number): DataStatus => ({
    ...STATUS,
    ...(timelineEpoch === undefined ? {} : { timelineEpoch }),
  });

  beforeEach(() => {
    useAppStore.setState(initialState());
    clearTripCache();
  });

  it("forgets the frame keys when the epoch changes, with no card mounted", () => {
    const store = useAppStore.getState();
    store.setStatus(status(2));
    seedTripOfKey(11, "a");
    store.setStatus(status(3));
    expect(
      renderHook(() => useTripOfKey(11, { fetch: async () => new Response("", { status: 404 }) }))
        .result.current.status,
    ).toBe("loading");
  });

  it("keeps them while the first status brings the epoch and while it stays the same", () => {
    const store = useAppStore.getState();
    store.setStatus(status());
    seedTripOfKey(12, "a");
    store.setStatus(status(0));
    store.setStatus(status(0));
    expect(
      renderHook(() => useTripOfKey(12, { fetch: async () => new Response("", { status: 404 }) }))
        .result.current.status,
    ).toBe("ready");
  });
});

describe("app store", () => {
  beforeEach(() => {
    useAppStore.setState(initialState());
  });

  it("starts dark with nothing selected", () => {
    const state = useAppStore.getState();

    expect(state.theme).toBe("dark");
    expect(state.selectedId).toBeNull();
    expect(state.liveSelection).toBeNull();
  });

  it("remembers that the map was used and stays that way", () => {
    expect(useAppStore.getState().mapInteracted).toBe(false);

    useAppStore.getState().markMapInteracted();
    useAppStore.getState().markMapInteracted();

    expect(useAppStore.getState().mapInteracted).toBe(true);
  });

  it("follows only a selected train and stops following when the selection changes", () => {
    const store = useAppStore.getState();
    store.setFollowing(true);
    expect(useAppStore.getState().following).toBe(false);

    store.select("live:5");
    store.setFollowing(true);
    expect(useAppStore.getState().following).toBe(true);

    store.select("live:6");
    expect(useAppStore.getState().following).toBe(false);

    store.setFollowing(true);
    store.select(null);
    expect(useAppStore.getState().following).toBe(false);
  });

  it("knows whether the map draws the selected train and stops following one it does not", () => {
    const store = useAppStore.getState();
    store.setSelectedDrawn(true, 5);
    expect(useAppStore.getState().selectedDrawn).toBeNull();

    store.select("live:5");
    expect(useAppStore.getState().selectedDrawn).toBeNull();
    store.setSelectedDrawn(true, 5);
    store.setFollowing(true);
    store.setSelectedDrawn(false, 5);
    expect(useAppStore.getState()).toMatchObject({ selectedDrawn: false, following: false });

    store.select("live:6");
    expect(useAppStore.getState().selectedDrawn).toBeNull();
  });

  it("ignores a drawn report of a train that is no longer the selected one", () => {
    const store = useAppStore.getState();
    store.select("live:5");
    store.setSelectedDrawn(true, 5);
    store.setFollowing(true);
    store.select("live:6");
    store.setFollowing(true);
    store.setSelectedDrawn(false, 5);
    expect(useAppStore.getState()).toMatchObject({ selectedDrawn: null, following: true });

    store.setSelectedDrawn(true, 6);
    expect(useAppStore.getState().selectedDrawn).toBe(true);

    store.select("77e5a1b2-0000-4000-8000-000000000000");
    store.setSelectedDrawn(true, 6);
    expect(useAppStore.getState().selectedDrawn).toBeNull();
  });

  it("counts route requests of the selected train and ignores them without a selection", () => {
    const store = useAppStore.getState();
    store.requestRoute();
    expect(useAppStore.getState().routeRequests).toBe(0);

    store.select("live:5");
    store.requestRoute();
    store.requestRoute();
    expect(useAppStore.getState().routeRequests).toBe(2);

    store.select("live:6");
    expect(useAppStore.getState().routeRequests).toBe(0);
  });

  it("keeps the profile, its hover and the stop positions of the selected train only", () => {
    const store = useAppStore.getState();
    const overlay = { legs: [], quantile: "median" } as const;
    store.setProfile(overlay);
    store.setRouteStops(stopsOf(0, 5));
    expect(useAppStore.getState()).toMatchObject({ profile: null, routeStops: null });

    store.select("live:5");
    store.setRouteStops(stopsOf(0, 5));
    store.setProfile(overlay);
    store.setProfileHover({ leg: 0, x: 10, y: 20 });
    expect(useAppStore.getState().profile).toBe(overlay);
    expect(useAppStore.getState().profileHover).toEqual({ leg: 0, x: 10, y: 20 });
    expect(Array.from(useAppStore.getState().routeStops?.vertices ?? [])).toEqual([0, 5]);

    store.setProfile(null);
    expect(useAppStore.getState().profileHover).toBeNull();
    store.setProfile(overlay);
    store.select("live:6");
    expect(useAppStore.getState()).toMatchObject({
      profile: null,
      profileHover: null,
      routeStops: null,
    });
    store.setProfileHover({ leg: 1, x: 1, y: 1 });
    expect(useAppStore.getState().profileHover).toBeNull();
  });

  it("holds the profile switch, measure and answer for the selected train only", () => {
    const store = useAppStore.getState();
    store.setProfileOn(true);
    expect(useAppStore.getState().profileOn).toBe(false);

    store.select("live:5");
    store.setProfileOn(true);
    store.setProfileQuantile("p80");
    store.setProfileView({ state: "loading" });
    store.retryProfile();
    expect(useAppStore.getState()).toMatchObject({
      profileOn: true,
      profileQuantile: "p80",
      profileView: { state: "loading" },
      profileRetries: 1,
    });

    store.setProfileOn(false);
    expect(useAppStore.getState().profileView).toEqual({ state: "idle" });
    store.setProfileOn(true);
    store.select("live:6");
    expect(useAppStore.getState()).toMatchObject({
      profileOn: false,
      profileQuantile: "median",
      profileView: { state: "idle" },
      profileRetries: 0,
    });
  });

  it("keeps the frame data of a live train, clears it on a new selection and notes its end", () => {
    useAppStore.getState().select("live:5");
    useAppStore.getState().setLiveSelection(LIVE_INFO);
    expect(useAppStore.getState().liveSelection).toBe(LIVE_INFO);

    useAppStore.getState().setLiveSelection(null);
    expect(useAppStore.getState()).toMatchObject({ liveSelection: null, selectionEnded: true });

    useAppStore.getState().select("live:6");
    expect(useAppStore.getState()).toMatchObject({ liveSelection: null, selectionEnded: false });
  });

  it("ignores live data that arrives after the card was closed", () => {
    useAppStore.getState().select("live:5");
    useAppStore.getState().select(null);

    useAppStore.getState().setLiveSelection(LIVE_INFO);

    expect(useAppStore.getState().liveSelection).toBeNull();
  });

  it("stores the data status and the zoom", () => {
    useAppStore.getState().setStatus(STATUS);
    useAppStore.getState().setZoom(7.2);

    expect(useAppStore.getState().status).toBe(STATUS);
    expect(useAppStore.getState().zoom).toBe(7.2);
  });

  it("closing the card clears everything about the selection", () => {
    useAppStore.getState().select("live:5");
    useAppStore.getState().setLiveSelection(LIVE_INFO);

    useAppStore.getState().select(null);

    expect(useAppStore.getState()).toMatchObject({
      selectedId: null,
      liveSelection: null,
      selectionEnded: false,
    });
  });

  it("changes the theme", () => {
    useAppStore.getState().setTheme("light");

    expect(useAppStore.getState().theme).toBe("light");
    expect(useAppStore.getState().mapStyle).toBe("light");
  });

  it("changes the map style and the interface theme it brings", () => {
    useAppStore.getState().setMapStyle("satellite");
    expect(useAppStore.getState()).toMatchObject({ mapStyle: "satellite", theme: "dark" });

    useAppStore.getState().setMapStyle("terrain");
    expect(useAppStore.getState()).toMatchObject({ mapStyle: "terrain", theme: "light" });
  });

  it("allows 3D terrain only in the terrain style and drops it when the style changes", () => {
    useAppStore.getState().setTerrain3d(true);
    expect(useAppStore.getState().terrain3d).toBe(false);

    useAppStore.getState().setMapStyle("terrain");
    useAppStore.getState().setTerrain3d(true);
    expect(useAppStore.getState().terrain3d).toBe(true);

    useAppStore.getState().setMapStyle("dark");
    expect(useAppStore.getState().terrain3d).toBe(false);
  });

  it("brings the relief back with the Terrain style when the user or the tier wants it", () => {
    useAppStore.setState({ terrainWanted: true });
    useAppStore.getState().setMapStyle("terrain");
    expect(useAppStore.getState().terrain3d).toBe(true);

    useAppStore.getState().setMapStyle("dark");
    useAppStore.getState().setMapStyle("terrain");
    expect(useAppStore.getState().terrain3d).toBe(true);

    useAppStore.getState().setTerrain3d(false);
    useAppStore.getState().setMapStyle("light");
    useAppStore.getState().setMapStyle("terrain");
    expect(useAppStore.getState().terrain3d).toBe(false);
  });

  it("keeps 3D buildings as a plain switch", () => {
    expect(useAppStore.getState().buildings).toBe(false);
    useAppStore.getState().setBuildings(true);
    expect(useAppStore.getState().buildings).toBe(true);
  });

  it("focuses a Land and clears the focus", () => {
    useAppStore.getState().setFocusLand("DE-BY");
    expect(useAppStore.getState().focusLand).toBe("DE-BY");

    useAppStore.getState().setFocusLand(null);
    expect(useAppStore.getState().focusLand).toBeNull();
  });

  it("ignores a focus value that is not a Land code", () => {
    useAppStore.getState().setFocusLand("DE-BE");
    useAppStore.getState().setFocusLand("../x" as never);

    expect(useAppStore.getState().focusLand).toBe("DE-BE");
    useAppStore.getState().setFocusLand(null);
  });

  it("hides a category and shows it again without touching the others", () => {
    useAppStore.getState().setCategoryVisible("reg", false);
    useAppStore.getState().setCategoryVisible("foreign", false);
    useAppStore.getState().setCategoryVisible("reg", false);

    expect(useAppStore.getState().hiddenCategories).toEqual(["foreign", "reg"]);

    useAppStore.getState().setCategoryVisible("foreign", true);

    expect(useAppStore.getState().hiddenCategories).toEqual(["reg"]);
  });

  it("hides an operator group and shows it again without touching the others", () => {
    useAppStore.getState().setOperatorGroupVisible("db", false);
    useAppStore.getState().setOperatorGroupVisible("unknown", false);
    useAppStore.getState().setOperatorGroupVisible("db", false);

    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["unknown", "db"]);

    useAppStore.getState().setOperatorGroupVisible("unknown", true);

    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["db"]);
  });

  it("keeps the hidden groups when the colour mode changes", () => {
    useAppStore.getState().setOperatorGroupVisible("db", false);
    useAppStore.getState().setColourMode("operator");
    useAppStore.getState().setColourMode("category");

    expect(useAppStore.getState().hiddenOperatorGroups).toEqual(["db"]);
  });
});
