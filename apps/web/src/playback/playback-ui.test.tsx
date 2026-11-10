// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveBar } from "../components/shell/LiveBar.tsx";
import type { PlaybackState } from "../live/playback/driver.ts";
import type { DataStatus, PlaybackCommand } from "../motion/protocol.ts";
import { initialState, useAppStore } from "../state/store.ts";
import PlaybackPanel from "./PlaybackPanel.tsx";
import { usePlaybackStore } from "./store.ts";

const NOW = Math.floor(Date.now() / 1000);
const LAST = Math.floor((NOW - 1800 - 3600) / 3600) * 3600;
const HOUR = 3600;

const STATUS: DataStatus = {
  state: "recorded",
  dataTimeMs: (LAST + 600) * 1000,
  trips: 1,
  realtime: 1,
  untracked: 0,
  counts: { hsr: 0, ld: 0, night: 0, rfast: 0, reg: 1, sbahn: 0, foreign: 0 },
  error: undefined,
};

function listBody(...starts: number[]) {
  return {
    data: {
      windows: starts.map((start) => ({
        start,
        end: start + HOUR,
        revision: "abcdef012345",
        shapeEpoch: 3,
      })),
      limits: { windowSeconds: HOUR, maxAgeSeconds: 7 * 24 * HOUR, settleSeconds: 1800 },
    },
  };
}

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

const sent: PlaybackCommand[] = [];

beforeEach(async () => {
  sent.length = 0;
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: STATUS });
  usePlaybackStore.setState({
    panelOpen: false,
    state: null,
    list: null,
    listStatus: "idle",
    speed: 1,
    send: (command) => sent.push(command),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPanel(...starts: number[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(listBody(...starts)), { status: 200 }),
  );
  usePlaybackStore.getState().openPanel();
  render(<PlaybackPanel />);
  await waitFor(() => expect(usePlaybackStore.getState().listStatus).toBe("ready"));
}

describe("History control in the live bar", () => {
  it("opens and closes the timeline and shows no Back to live while the live source runs", () => {
    render(<LiveBar />);
    const history = screen.getByRole("button", { name: "History" });
    expect(history.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Back to live" })).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(listBody(LAST)), { status: 200 }),
    );
    fireEvent.click(history);
    expect(usePlaybackStore.getState().panelOpen).toBe(true);
  });

  it("says Playback and offers Back to live while a playback runs", () => {
    usePlaybackStore.setState({ state: playbackState() });
    render(<LiveBar />);
    expect(screen.getByRole("status").textContent).toContain("Playback");
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    expect(sent).toEqual([{ action: "stop" }]);
  });

  it("lets Back to live wrap to its own row, on the bar and on the stacked phone bar", () => {
    usePlaybackStore.setState({ state: playbackState() });
    const { unmount } = render(<LiveBar />);
    const wide = screen.getByRole("button", { name: "Back to live" });
    const bar = document.querySelector("[data-slot=live-bar]") as HTMLElement;
    expect(wide.parentElement?.className).toBe("contents");
    expect(wide.parentElement?.parentElement).toBe(bar);
    expect(bar.className.split(" ")).toContain("flex-wrap");
    expect(bar.className.split(" ")).toContain("max-w-full");
    unmount();

    render(<LiveBar stacked />);
    const stacked = screen.getByRole("button", { name: "Back to live" });
    expect(stacked.parentElement?.className).toBe("contents");
    const row = stacked.parentElement?.parentElement as HTMLElement;
    expect(row.className.split(" ")).toContain("flex-wrap");
    expect(row.contains(screen.getByRole("button", { name: "History" }))).toBe(true);
    const phoneBar = document.querySelector("[data-slot=live-bar]") as HTMLElement;
    expect(phoneBar.className.split(" ")).toContain("max-w-full");
  });

  it("pads the wrapped rows of the bar only while a playback runs", () => {
    render(<LiveBar />);
    const idle = document.querySelector("[data-slot=live-bar]") as HTMLElement;
    expect(idle.className.split(" ")).not.toContain("py-1");
    cleanup();
    usePlaybackStore.setState({ state: playbackState() });
    render(<LiveBar />);
    const playing = document.querySelector("[data-slot=live-bar]") as HTMLElement;
    expect(playing.className.split(" ")).toContain("py-1");
  });

  it("shows nothing where no live map can play a past hour", () => {
    usePlaybackStore.setState({ send: null });
    render(<LiveBar />);
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });
});

describe("timeline panel", () => {
  it("offers the newest rendered hour and starts the playback paused nowhere: it plays", async () => {
    await openPanel(LAST, LAST - 2 * HOUR);
    const hour = screen.getByLabelText("Hour") as HTMLSelectElement;
    expect(Number(hour.value)).toBe(LAST);
    fireEvent.click(screen.getByRole("button", { name: "Show this hour" }));
    expect(sent).toEqual([{ action: "start", at: LAST, speed: 1, playing: true }]);
  });

  it("draws the Day and Hour selects in the field style, 40 px on desktop and 44 px on a phone", async () => {
    await openPanel(LAST);
    for (const name of ["Day", "Hour"]) {
      const classes = screen.getByLabelText(name).className.split(" ");
      expect(classes).toContain("h-target");
      expect(classes).not.toContain("flex-1");
    }
  });

  it("gives the Day select the larger share, so a long Polish date reads in full on a phone", async () => {
    await openPanel(LAST);
    const share = (name: string) => screen.getByLabelText(name).closest("label")?.className;
    expect(share("Day")?.split(" ")).toContain("flex-3");
    expect(share("Hour")?.split(" ")).toContain("flex-2");
  });

  it("marks an hour that was not rendered as missing and does not let it be picked", async () => {
    await openPanel(LAST, LAST - 2 * HOUR);
    const hour = screen.getByLabelText("Hour");
    const missing = within(hour).getAllByRole("option", { name: /no data/ });
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((option) => (option as HTMLOptionElement).disabled)).toBe(true);
  });

  it("says when no hour is ready and when the list cannot be loaded, with a way to retry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(listBody()), { status: 200 }),
    );
    usePlaybackStore.getState().openPanel();
    render(<PlaybackPanel />);
    await screen.findByText("No past hours are ready yet.");
    cleanup();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    usePlaybackStore.setState({ list: null, listStatus: "idle" });
    usePlaybackStore.getState().openPanel();
    render(<PlaybackPanel />);
    await screen.findByText("The list of hours could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("plays, pauses, changes speed and seeks with the controls", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({ state: playbackState() });
    await screen.findByRole("button", { name: "Pause" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "10x" }));
    const scrubber = screen.getByRole("slider", { name: "Position in the hour" });
    fireEvent.change(scrubber, { target: { value: String(LAST + 1800) } });
    fireEvent.pointerUp(scrubber);
    expect(sent).toEqual([
      { action: "pause" },
      { action: "speed", speed: 10 },
      { action: "seek", at: LAST + 1800 },
    ]);
    expect(screen.getByRole("button", { name: "10x" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the scrubber keyboard operable: a key press commits a seek", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({ state: playbackState({ playing: false, phase: "paused" }) });
    const scrubber = await screen.findByRole("slider", { name: "Position in the hour" });
    fireEvent.change(scrubber, { target: { value: String(LAST + 660) } });
    fireEvent.keyUp(scrubber, { key: "ArrowRight" });
    expect(sent).toEqual([{ action: "seek", at: LAST + 660 }]);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("names each error and the end of the last hour, and closes with Escape", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({
      state: playbackState({ phase: "error", error: "epoch_mismatch" }),
    });
    expect(
      await screen.findByText("This hour was recorded on a track set that is no longer served."),
    ).toBeTruthy();
    usePlaybackStore.setState({ state: playbackState({ notice: "not_rendered" }) });
    expect(await screen.findByText("This hour has not been rendered.")).toBeTruthy();
    usePlaybackStore.setState({ state: playbackState({ phase: "ended" }) });
    expect(await screen.findByText(/End of the last ready hour/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("region", { name: "Playback of a past hour" }), {
      key: "Escape",
    });
    expect(usePlaybackStore.getState().panelOpen).toBe(false);
  });

  it("is written in German and Polish too", async () => {
    await changeLocale("de", { persist: false });
    await openPanel(LAST);
    expect(screen.getByRole("button", { name: "Diese Stunde zeigen" })).toBeTruthy();
    cleanup();
    await changeLocale("pl", { persist: false });
    render(<PlaybackPanel />);
    expect(screen.getByRole("button", { name: "Pokaż tę godzinę" })).toBeTruthy();
  });
});

describe("panel upkeep", () => {
  it("gives the scrubber's spoken value to the minute while playing and to the second otherwise", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({ state: playbackState({ position: LAST + 605 }) });
    const scrubber = await screen.findByRole("slider", { name: "Position in the hour" });
    const spoken = scrubber.getAttribute("aria-valuetext") ?? "";
    expect(spoken).toMatch(/^\d{2}:\d{2}$/);
    act(() => usePlaybackStore.setState({ state: playbackState({ position: LAST + 625 }) }));
    expect(scrubber.getAttribute("aria-valuetext")).toBe(spoken);
    act(() =>
      usePlaybackStore.setState({
        state: playbackState({ playing: false, phase: "paused", position: LAST + 625 }),
      }),
    );
    expect(scrubber.getAttribute("aria-valuetext")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("drops a drag that the pointer cancelled and sends no seek", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({ state: playbackState({ playing: false, phase: "paused" }) });
    const scrubber = (await screen.findByRole("slider", {
      name: "Position in the hour",
    })) as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: String(LAST + 1800) } });
    expect(scrubber.value).toBe(String(LAST + 1800));
    fireEvent.pointerCancel(scrubber);
    expect(scrubber.value).toBe(String(LAST + 600));
    expect(sent).toEqual([]);
  });

  it("returns the focus to History when Escape closes the timeline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(listBody(LAST)), { status: 200 }),
    );
    render(
      <>
        <LiveBar />
        <PlaybackPanel />
      </>,
    );
    usePlaybackStore.getState().openPanel();
    const hour = await screen.findByLabelText("Hour");
    (hour as HTMLElement).focus();
    fireEvent.keyDown(hour, { key: "Escape" });
    expect(usePlaybackStore.getState().panelOpen).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "History" }));
  });

  it("keeps one alert region for problems and one status region for progress", async () => {
    await openPanel(LAST);
    usePlaybackStore.setState({ state: playbackState() });
    const alert = await screen.findByRole("alert");
    const status = screen.getAllByRole("status");
    expect(status).toHaveLength(1);
    expect(alert).not.toBe(status[0]);
    usePlaybackStore.setState({ state: playbackState({ phase: "seeking" }) });
    expect(await screen.findByText("Jumping to the new time")).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toBe("");
    expect(screen.getByRole("alert").textContent).toBe("");
    usePlaybackStore.setState({ state: playbackState({ notice: "not_rendered" }) });
    expect(await screen.findByText("This hour has not been rendered.")).toBeTruthy();
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert.textContent).toContain("This hour has not been rendered.");
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
