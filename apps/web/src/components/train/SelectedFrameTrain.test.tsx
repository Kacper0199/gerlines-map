// @vitest-environment happy-dom
import type { TrainDetail } from "@gerlines/schema";
import { TooltipProvider } from "@gerlines/ui";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTripCache, useTripOfKey } from "../../hooks/use-frame-trip.ts";
import type { DataStatus, LiveSelectionInfo } from "../../motion/protocol.ts";
import { usePlaybackStore } from "../../playback/store.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { DesktopShell } from "../shell/DesktopShell.tsx";
import { SelectedTrain } from "./SelectedTrain.tsx";
import { MINUTE, T0, testDetail } from "./test-detail.ts";

const KEY = 25714801;
const ID = "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11";
const NOW = T0 + 30 * MINUTE;

const INFO: LiveSelectionInfo = {
  key: KEY,
  line: "12",
  trainNumber: 597,
  category: "hsr",
  foreign: false,
  realtime: true,
  delaySeconds: 360,
  dataTimeMs: NOW,
  speedMps: null,
};

const STATUS: DataStatus = {
  state: "live",
  dataTimeMs: NOW,
  trips: 10,
  realtime: 8,
  untracked: 0,
  counts: { hsr: 1, ld: 0, night: 0, rfast: 0, reg: 0, sbahn: 0, foreign: 0 },
  error: undefined,
};

function detail(over: Partial<TrainDetail> = {}): TrainDetail {
  return testDetail({
    tripInstanceId: ID,
    frameKey: KEY,
    productName: "ICE",
    line: "12",
    trainNumber: "597",
    ...over,
  });
}

interface Api {
  lookup: "found" | "none" | "down";
  detail: TrainDetail;
  readonly calls: string[];
}

function serve(api: Api) {
  const fetch = vi.fn(async (input: string) => {
    api.calls.push(input);
    if (input.startsWith("/api/v1/live/keys/")) {
      if (api.lookup === "none") return new Response("", { status: 404 });
      if (api.lookup === "down") throw new TypeError("offline");
      return new Response(JSON.stringify({ tripInstanceId: ID }), { status: 200 });
    }
    return new Response(JSON.stringify(api.detail), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"1"' },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function select(id: string, extra: Partial<ReturnType<typeof initialState>> = {}) {
  useAppStore.setState({
    ...initialState(),
    selectedId: id,
    liveSelection: INFO,
    selectedDrawn: true,
    status: STATUS,
    ...extra,
  });
}

function renderCard(phone = false) {
  return render(
    <TooltipProvider>
      <SelectedTrain phone={phone} />
    </TooltipProvider>,
  );
}

function renderShell() {
  return render(
    <TooltipProvider>
      <DesktopShell onZoom={() => undefined} />
    </TooltipProvider>,
  );
}

vi.setConfig({ testTimeout: 15_000 });

let api: Api;
beforeAll(async () => {
  await import("./card/LiveTrainCard.tsx");
});
beforeEach(() => {
  clearTripCache();
  api = { lookup: "found", detail: detail(), calls: [] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SelectedTrain for a train of our frames, with the detail", () => {
  it("looks the trip up by its key, shows a loading card, then the product and number from the detail", async () => {
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    expect(screen.getByRole("status").textContent).toBe("Loading train");
    expect(await screen.findByRole("heading", { name: "ICE 597" }, { timeout: 5000 })).toBeTruthy();
    expect(api.calls[0]).toBe(`/api/v1/live/keys/${KEY}`);
    expect(api.calls[1]).toBe(`/api/v1/trains/${ID}`);
  });

  it("shows the destination, the next stop with its delay and the three actions", async () => {
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    await screen.findByRole("heading", { name: "ICE 597" }, { timeout: 5000 });
    expect(screen.getByText("To Hannover Hbf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Route" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("never titles a train without a product with a bare number", async () => {
    api.detail = detail({ productName: null, line: "12" });
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    expect(
      await screen.findByRole("heading", { name: "Train 597" }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText("Line 12")).toBeTruthy();
  });

  it("follows the camera on the train from the Follow button and says so", async () => {
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    const follow = await screen.findByRole("button", { name: "Follow" }, { timeout: 5000 });
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(follow);
    expect(useAppStore.getState().following).toBe(true);
    expect(screen.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    useAppStore.getState().setFollowing(false);
    expect(await screen.findByRole("button", { name: "Follow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("asks the map for the route ahead from the Route button", async () => {
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Route" }, { timeout: 5000 }));
    fireEvent.click(screen.getByRole("button", { name: "Route" }));

    expect(useAppStore.getState().routeRequests).toBe(2);
  });

  it("shares a link that holds the trip instance and keeps the other parameters", async () => {
    serve(api);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    select(`live:${KEY}`);
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Share" }, { timeout: 5000 }));
    await screen.findAllByText("Link copied");

    const url = new URL((writeText.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("train")).toBe(ID);
  });
});

describe("SelectedTrain and the map's view of the train", () => {
  it("hides Follow and Route for a train the map does not draw, keeps Share and says why", async () => {
    serve(api);
    select(`live:${KEY}`, { selectedDrawn: false });
    renderCard();

    await screen.findByRole("heading", { name: "ICE 597" });
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.getByText(/This train is not on the map/)).toBeTruthy();
    expect(screen.queryByText("How is the position found?")).toBeNull();
  });

  it.each([false, true])(
    "writes the sentence under the destination, not in the provenance (phone %s)",
    async (phone) => {
      serve(api);
      select(`live:${KEY}`, { selectedDrawn: false });
      renderCard(phone);

      await screen.findByRole("heading", { name: "ICE 597" });
      const sentence = screen.getByText(/This train is not on the map/);
      expect(sentence.closest("header")).not.toBeNull();
      expect(sentence.textContent).not.toMatch(/Realtime data|Timetable from|Data from/);
      expect(sentence.previousElementSibling?.textContent).toContain("To Hannover Hbf");
    },
  );

  it("offers nothing on the map until the worker has said whether the train is drawn", async () => {
    serve(api);
    select(`live:${KEY}`, { selectedDrawn: null });
    renderCard();

    await screen.findByRole("heading", { name: "ICE 597" });
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByText(/not on the map/)).toBeNull();
  });

  it("brings the actions back when the train becomes drawn", async () => {
    serve(api);
    select(`live:${KEY}`, { selectedDrawn: false });
    renderCard();
    await screen.findByRole("heading", { name: "ICE 597" });

    act(() => useAppStore.getState().setSelectedDrawn(true, KEY));

    expect(await screen.findByRole("button", { name: "Follow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Route" })).toBeTruthy();
    expect(screen.queryByText(/This train is not on the map/)).toBeNull();
  });

  it("counts the minutes to the next stop with the engine clock, not the device clock", async () => {
    serve(api);
    select(`live:${KEY}`, { status: { ...STATUS, dataTimeMs: NOW } });
    renderCard();

    await screen.findByRole("heading", { name: "ICE 597" });
    expect(screen.getByText("About 16 min to the next stop")).toBeTruthy();
  });

  it("floors the minutes at less than a minute when the engine clock is past the arrival", async () => {
    serve(api);
    select(`live:${KEY}`, { status: { ...STATUS, dataTimeMs: T0 + 46 * MINUTE + 30_000 } });
    renderCard();

    await screen.findByRole("heading", { name: "ICE 597" });
    expect(screen.getByText("Less than a minute to the next stop")).toBeTruthy();
  });
});

describe("SelectedTrain and the live time line", () => {
  it("forgets which trip a frame key stood for when the time line restarts", async () => {
    serve(api);
    select(`live:${KEY}`, { status: { ...STATUS, timelineEpoch: 0 } });
    renderCard();
    await screen.findByRole("heading", { name: "ICE 597" });
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    expect(renderHook(() => useTripOfKey(KEY, { fetch })).result.current.status).toBe("ready");

    act(() => useAppStore.getState().setStatus({ ...STATUS, timelineEpoch: 1 }));

    expect(renderHook(() => useTripOfKey(KEY, { fetch })).result.current.status).toBe("loading");
  });
});

describe("SelectedTrain at start-up", () => {
  it("keeps the trip of a shared link when the first status brings the time line epoch", async () => {
    serve(api);
    select(ID);
    renderShell();
    await screen.findByRole("heading", { name: "ICE 597" });
    await vi.waitFor(() => expect(useAppStore.getState().selectedId).toBe(`live:${KEY}`));

    act(() => useAppStore.getState().setStatus({ ...STATUS, timelineEpoch: 0 }));
    act(() =>
      useAppStore.getState().setStatus({ ...STATUS, timelineEpoch: 0, dataTimeMs: NOW + 15_000 }),
    );

    expect(useAppStore.getState().selectedId).toBe(`live:${KEY}`);
    expect(screen.getByRole("heading", { name: "ICE 597" })).toBeTruthy();
  });
});

describe("SelectedTrain for a train of our frames, without the detail", () => {
  it("shows what the frame knows and says the stops are not available when the key is unknown", async () => {
    api.lookup = "none";
    serve(api);
    select(`live:${KEY}`);
    renderCard();

    expect(await screen.findByText(/Stops and platforms are not available right now/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Train 597" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
  });

  it("upgrades to the detail card when a later lookup finds the train", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    api.lookup = "none";
    serve(api);
    select(`live:${KEY}`);
    renderCard();
    await vi.waitFor(() =>
      expect(screen.getByText(/Stops and platforms are not available/)).toBeTruthy(),
    );

    api.lookup = "found";
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(await screen.findByRole("heading", { name: "ICE 597" }, { timeout: 5000 })).toBeTruthy();
  });
});

describe("SelectedTrain for a train of our frames whose detail is missing", () => {
  it.each([404, 503])(
    "shows the frame card and says the stops are not available when the detail answers %i",
    async (status) => {
      const fetch = vi.fn(async (input: string) =>
        input.startsWith("/api/v1/live/keys/")
          ? new Response(JSON.stringify({ tripInstanceId: ID }), { status: 200 })
          : new Response("", { status }),
      );
      vi.stubGlobal("fetch", fetch);
      select(`live:${KEY}`);
      renderCard();

      expect(
        await screen.findByText(/Stops and platforms are not available right now/),
      ).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Train 597" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    },
  );

  it("shows the detail card again when a later refresh finds the detail", async () => {
    let found = false;
    const fetch = vi.fn(async (input: string) => {
      if (input.startsWith("/api/v1/live/keys/")) {
        return new Response(JSON.stringify({ tripInstanceId: ID }), { status: 200 });
      }
      return found
        ? new Response(JSON.stringify(detail()), { status: 200, headers: { etag: '"1"' } })
        : new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    select(`live:${KEY}`);
    renderCard();
    await vi.waitFor(() =>
      expect(screen.getByText(/Stops and platforms are not available/)).toBeTruthy(),
    );
    found = true;
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await screen.findByRole("heading", { name: "ICE 597" })).toBeTruthy();
  });
});

describe("SelectedTrain stand-in during the detail retries", () => {
  it("keeps the frame card on screen while each retry is waiting for its answer", async () => {
    const standInAtRequest: boolean[] = [];
    const fetch = vi.fn(async (input: string) => {
      if (input.startsWith("/api/v1/live/keys/")) {
        return new Response(JSON.stringify({ tripInstanceId: ID }), { status: 200 });
      }
      standInAtRequest.push(screen.queryByText(/Stops and platforms are not available/) !== null);
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    select(`live:${KEY}`);
    renderCard();
    await vi.waitFor(() => expect(standInAtRequest).toHaveLength(1));
    for (let second = 0; second < 90; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(standInAtRequest.length).toBeGreaterThanOrEqual(4);
    expect(standInAtRequest.slice(1).every(Boolean)).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SelectedTrain opened from a shared link", () => {
  it("selects the train on the map by the key its detail names, without loading the card twice", async () => {
    serve(api);
    select(ID, { liveSelection: null });
    renderShell();

    const heading = await screen.findByRole("heading", { name: "ICE 597" }, { timeout: 5000 });
    await vi.waitFor(() => expect(useAppStore.getState().selectedId).toBe(`live:${KEY}`));

    expect(screen.getByRole("heading", { name: "ICE 597" })).toBe(heading);
    expect(api.calls.filter((call) => call.startsWith("/api/v1/trains/"))).toHaveLength(1);
    expect(api.calls.some((call) => call.startsWith("/api/v1/live/keys/"))).toBe(false);
  });

  it("stays a card without a map selection for a train the frames do not hold", async () => {
    api.detail = detail({ frameKey: null });
    serve(api);
    select(ID, { liveSelection: null });
    renderCard();

    expect(await screen.findByRole("heading", { name: "ICE 597" }, { timeout: 5000 })).toBeTruthy();
    expect(useAppStore.getState().selectedId).toBe(ID);
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });
});

describe("SelectedTrain in a playback", () => {
  afterEach(() => {
    usePlaybackStore.setState({ state: null });
  });

  it("shows what the frames of that moment knew, with the playback time, and asks the API for nothing", async () => {
    serve(api);
    select(`live:${KEY}`);
    usePlaybackStore.setState({
      state: {
        phase: "playing",
        playing: true,
        position: NOW / 1000,
        speed: 1,
        windowStart: 0,
        windowEnd: 3600,
        error: null,
        notice: null,
      },
    });
    renderCard();

    expect(screen.getByRole("heading", { name: "Train 597" })).toBeTruthy();
    expect(
      screen.getByText(/Playback shows the train as the frames of that moment knew it/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("asks for no detail, profile or curtain of today for a train picked by its trip while a playback runs", async () => {
    const fetch = serve(api);
    select(ID, { profileOn: true });
    usePlaybackStore.setState({
      state: {
        phase: "playing",
        playing: true,
        position: NOW / 1000,
        speed: 1,
        windowStart: 0,
        windowEnd: 3600,
        error: null,
        notice: null,
      },
    });
    renderCard();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
    expect(useAppStore.getState().profile).toBeNull();
  });
});
