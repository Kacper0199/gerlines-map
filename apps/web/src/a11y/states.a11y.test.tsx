// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import type { StatsNetwork } from "@gerlines/schema/stats";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../../test/helpers/axe.ts";
import { LiveBar } from "../components/shell/LiveBar.tsx";
import { StationPanel } from "../components/station/StationPanel.tsx";
import type { PlaybackState } from "../live/playback/driver.ts";
import type { DataStatus } from "../motion/protocol.ts";
import PlaybackPanel from "../playback/PlaybackPanel.tsx";
import { PlaybackSlot } from "../playback/PlaybackSlot.tsx";
import { usePlaybackStore } from "../playback/store.ts";
import { resetPanelStore, usePanelOpen, usePanelStore } from "../state/panel-store.ts";
import { resetPlaceStore, usePlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import land from "../stats/fixtures/land-by-2025-11.json" with { type: "json" };
import network from "../stats/fixtures/network-2025-11.json" with { type: "json" };
import station from "../stats/fixtures/station-2025-11.json" with { type: "json" };
import train from "../stats/fixtures/train-596-2025-11.json" with { type: "json" };
import StatsPanel from "../stats/StatsPanel.tsx";
import { initialStatsState, useStatsStore } from "../stats/store.ts";

vi.mock("../stats/use-laender.ts", () => ({
  useLaender: () => [{ code: "DE-BY", names: { en: "Bavaria", de: "Bayern", pl: "Bawaria" } }],
}));

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const LAST = Math.floor((NOW - 1800 - HOUR) / HOUR) * HOUR;

const STATUS: DataStatus = {
  state: "recorded",
  dataTimeMs: (LAST + 600) * 1000,
  trips: 1,
  realtime: 1,
  untracked: 0,
  counts: { hsr: 0, ld: 0, night: 0, rfast: 0, reg: 1, sbahn: 0, foreign: 0 },
  error: undefined,
};

const STATION = {
  id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
  name: "Köln Hbf",
  lon: 6.958729,
  lat: 50.94303,
  eva: 8000207,
  dhid: "de:05315:11201",
  lines: ["RE1", "RE5", "S11"],
  trainsToday: 1207,
};

function playbackState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    phase: "playing",
    playing: true,
    position: LAST + 600,
    speed: 1,
    windowStart: LAST,
    windowEnd: LAST + HOUR,
    error: null,
    notice: null,
    ...overrides,
  };
}

function hoursAnswer(): Response {
  return new Response(
    JSON.stringify({
      data: {
        windows: [LAST, LAST - HOUR].map((start) => ({
          start,
          end: start + HOUR,
          revision: "abcdef012345",
          shapeEpoch: 3,
        })),
        limits: { windowSeconds: HOUR, maxAgeSeconds: 7 * 24 * HOUR, settleSeconds: 1800 },
      },
    }),
    { status: 200 },
  );
}

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: STATUS });
  resetPlaceStore();
  resetPanelStore();
  usePlaybackStore.setState({
    panelOpen: false,
    state: null,
    list: null,
    listStatus: "idle",
    speed: 1,
    send: () => undefined,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("station card", () => {
  it("has no axe violations for a station, a missing one and a failed one, on desktop and phone", async () => {
    usePlaceStore.getState().selectStation(STATION);
    for (const phone of [false, true]) {
      const { container } = render(<StationPanel phone={phone} />);
      expect(await axeViolations(container)).toEqual([]);
      cleanup();
    }
    resetPlaceStore();
    usePlaceStore.setState({ missingStation: { id: STATION.id, reason: "not-found" } });
    const missing = render(<StationPanel phone={false} />);
    expect(await axeViolations(missing.container)).toEqual([]);
    cleanup();
    usePlaceStore.setState({ missingStation: { id: STATION.id, reason: "error" } });
    const failed = render(<StationPanel phone />);
    expect(await axeViolations(failed.container)).toEqual([]);
  });
});

describe("timeline", () => {
  it("has no axe violations picking an hour, playing, and after an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(hoursAnswer());
    usePlaybackStore.getState().openPanel();
    const picking = render(<PlaybackPanel />);
    await waitFor(() => expect(usePlaybackStore.getState().listStatus).toBe("ready"));
    expect(await axeViolations(picking.container)).toEqual([]);
    cleanup();
    usePlaybackStore.setState({ state: playbackState() });
    const playing = render(<PlaybackPanel />);
    expect(await axeViolations(playing.container)).toEqual([]);
    cleanup();
    usePlaybackStore.setState({ state: playbackState({ playing: false, error: "offline" }) });
    const failed = render(<PlaybackPanel />);
    expect(await axeViolations(failed.container)).toEqual([]);
  });

  it("moves the focus into the timeline when History opens it, and back to History on Escape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(hoursAnswer());
    const user = userEvent.setup();
    render(
      <>
        <PlaybackSlot />
        <LiveBar />
      </>,
    );
    const history = screen.getByRole("button", { name: "History" });
    await user.click(history);
    const panel = await screen.findByRole("region", { name: "Playback of a past hour" });
    const heading = panel.querySelector("h2");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(history);
  });

  it("does not pull the focus when the timeline opens from a link while focus is elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(hoursAnswer());
    render(
      <>
        <button type="button">Elsewhere</button>
        <PlaybackSlot />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    usePlaybackStore.getState().openPanel();
    await screen.findByRole("region", { name: "Playback of a past hour" });
    expect(document.activeElement).toBe(elsewhere);
  });
});

function StatsSlotHost() {
  return usePanelOpen("stats") ? <StatsPanel phone={false} /> : null;
}

describe("statistics", () => {
  function stub() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(network as unknown as StatsNetwork))),
    );
  }

  beforeEach(() => {
    usePanelStore.getState().open("stats");
    useStatsStore.setState({
      ...initialStatsState(),
      period: { kind: "month", year: 2025, month: 11 },
    });
  });

  it("has no axe violations while loading and with the network figures, on desktop and phone", async () => {
    stub();
    for (const phone of [false, true]) {
      const { container } = render(<StatsPanel phone={phone} />);
      expect(await axeViolations(container)).toEqual([]);
      await screen.findByText(/trains/i, {}, { timeout: 5000 });
      expect(await axeViolations(container)).toEqual([]);
      cleanup();
    }
  });

  it("has no axe violations for a Land, a station and a train, with charts and with their tables", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const body = input.includes("/lands/")
          ? land
          : input.includes("/stations/")
            ? station
            : input.includes("/trains/")
              ? train
              : network;
        return new Response(JSON.stringify(body));
      }),
    );
    const areas = [
      { kind: "land", area: { kind: "land", code: "DE-BY" } },
      {
        kind: "station",
        area: { kind: "station", id: station.station.id, name: station.station.name },
      },
      { kind: "train", area: { kind: "train", number: "596" } },
    ] as const;
    for (const tables of [false, true]) {
      for (const entry of areas) {
        useStatsStore.setState({ kind: entry.kind, area: entry.area, tables });
        const { container } = render(<StatsPanel phone={false} />);
        await waitFor(() => expect(container.querySelector("[aria-busy=false]")).toBeTruthy(), {
          timeout: 5000,
        });
        expect(await axeViolations(container)).toEqual([]);
        cleanup();
      }
    }
  });

  it("gives the focus back to the Statistics button when the panel closes", async () => {
    stub();
    const user = userEvent.setup();
    render(
      <>
        <button type="button" data-slot="stats-button">
          Statistics
        </button>
        <StatsSlotHost />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Close statistics" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Statistics")));
  });

  it("closes with Escape", async () => {
    stub();
    render(<StatsPanel phone={false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(usePanelStore.getState().active).toBeNull();
  });
});
