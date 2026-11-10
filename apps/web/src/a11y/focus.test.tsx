// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchCard } from "../components/shell/SearchCard.tsx";
import { StationPanel } from "../components/station/StationPanel.tsx";
import { SelectedTrain } from "../components/train/SelectedTrain.tsx";
import { usePanelCardSwitch } from "../state/panel-cards.ts";
import { resetPanelStore, usePanelOpen, usePanelStore } from "../state/panel-store.ts";
import { resetPlaceStore, usePlaceStore } from "../state/place-store.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { restoreFocus } from "./focus.ts";
import { describeCanvas, MAP_KEYS_ID } from "./map-canvas.ts";
import { SkipLink } from "./SkipLink.tsx";
import { useFocusOnOpen } from "./use-focus-on-open.ts";

const STATION = {
  id: "4eda9b92-2ddf-5610-b59b-ed665a8b2610",
  name: "Köln Hbf",
  lon: 6.958729,
  lat: 50.94303,
  eva: 8000207,
  dhid: "de:05315:11201",
  lines: ["RE1"],
  trainsToday: 12,
};

function addCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "maplibregl-canvas";
  canvas.tabIndex = 0;
  document.body.append(canvas);
  return canvas;
}

function TrainHost() {
  const selected = useAppStore((state) => state.selectedId);
  return selected === null ? null : <SelectedTrain phone={false} />;
}

function StatsHeadingHost() {
  const open = usePanelOpen("stats");
  return open ? <StatsHeading /> : null;
}

function StatsHeading() {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnOpen(heading, true);
  return (
    <h2 ref={heading} tabIndex={-1}>
      Statistics
    </h2>
  );
}

function ShellHost() {
  usePanelCardSwitch();
  return (
    <>
      <StatsHeadingHost />
      <TrainHost />
    </>
  );
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

beforeEach(async () => {
  await changeLocale("en");
  resetPlaceStore();
  resetPanelStore();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
});
afterEach(() => {
  cleanup();
  document.querySelectorAll(".maplibregl-canvas").forEach((node) => {
    node.remove();
  });
  vi.unstubAllGlobals();
});

describe("skip link", () => {
  it("is the first stop and moves the focus to the search field", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <SearchCard />
      </>,
    );
    await user.tab();
    const link = screen.getByRole("button", { name: "Skip to search" });
    expect(document.activeElement).toBe(link);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search" }));
  });

  it("speaks the interface language", async () => {
    await changeLocale("pl", { persist: false });
    render(<SkipLink />);
    expect(screen.getByRole("button", { name: "Przejdź do wyszukiwania" })).toBeTruthy();
  });
});

describe("focus after a card closes", () => {
  it("goes to the map when the station card closes with its button", async () => {
    const user = userEvent.setup();
    const canvas = addCanvas();
    usePlaceStore.getState().selectStation(STATION);
    render(<StationPanel phone={false} />);
    await user.click(screen.getByRole("button", { name: "Close station card" }));
    await nextFrame();
    expect(document.activeElement).toBe(canvas);
  });

  it("goes to the map when the station card closes with Escape", async () => {
    const user = userEvent.setup();
    const canvas = addCanvas();
    usePlaceStore.getState().selectStation(STATION);
    render(<StationPanel phone={false} />);
    await user.keyboard("{Escape}");
    await nextFrame();
    expect(document.activeElement).toBe(canvas);
  });

  it("goes to the map when the train card closes with its button", async () => {
    const canvas = addCanvas();
    useAppStore.setState({ ...initialState(), selectedId: "live:1" });
    render(<TrainHost />);
    const close = screen.getByRole("button", { name: "Close train card" });
    close.focus();
    fireEvent.click(close);
    await nextFrame();
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it("goes to the map when the train card closes with Escape", async () => {
    const user = userEvent.setup();
    const canvas = addCanvas();
    useAppStore.setState({ ...initialState(), selectedId: "live:1" });
    render(<TrainHost />);
    await user.keyboard("{Escape}");
    await nextFrame();
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it("leaves a focus that moved on alone", async () => {
    const canvas = addCanvas();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    restoreFocus(() => canvas);
    await nextFrame();
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe("focus after a card closes over a set aside panel", () => {
  it("goes to the map, not to the heading of the panel that comes back", async () => {
    const user = userEvent.setup();
    const canvas = addCanvas();
    render(<ShellHost />);
    act(() => usePanelStore.getState().open("stats"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Statistics" }));

    act(() => useAppStore.getState().select("live:1"));
    expect(screen.queryByRole("heading", { name: "Statistics" })).toBeNull();
    await user.keyboard("{Escape}");
    await nextFrame();

    expect(useAppStore.getState().selectedId).toBeNull();
    expect(screen.getByRole("heading", { name: "Statistics" })).toBeTruthy();
    expect(document.activeElement).toBe(canvas);
  });

  it("gives the heading the focus again when the user opens the panel after that", async () => {
    addCanvas();
    render(<ShellHost />);
    act(() => usePanelStore.getState().open("stats"));
    act(() => useAppStore.getState().select("live:1"));
    act(() => useAppStore.getState().select(null));
    act(() => usePanelStore.getState().close("stats"));
    act(() => usePanelStore.getState().open("stats"));

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Statistics" }));
  });
});

describe("map canvas", () => {
  it("is named in the interface language and described by the keys that move it", () => {
    const canvas = addCanvas();
    describeCanvas(canvas, "Karte");
    expect(canvas.getAttribute("aria-label")).toBe("Karte");
    expect(canvas.getAttribute("aria-describedby")).toBe(MAP_KEYS_ID);
  });
});
