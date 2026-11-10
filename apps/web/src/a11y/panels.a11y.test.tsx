// @vitest-environment happy-dom
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../../test/helpers/axe.ts";
import { MapFailure } from "../components/MapErrorBoundary.tsx";
import { Attribution } from "../components/shell/Attribution.tsx";
import { DesktopShell } from "../components/shell/DesktopShell.tsx";
import { LandChip } from "../components/shell/LandChip.tsx";
import { LayersPopover } from "../components/shell/LayersPopover.tsx";
import { LegendCard } from "../components/shell/LegendCard.tsx";
import { LiveBar } from "../components/shell/LiveBar.tsx";
import { LocaleSwitch } from "../components/shell/LocaleSwitch.tsx";
import { PhoneShell } from "../components/shell/PhoneShell.tsx";
import { SearchCard } from "../components/shell/SearchCard.tsx";
import { StylePicker } from "../components/shell/StylePicker.tsx";
import { ZoomControls } from "../components/shell/ZoomControls.tsx";
import { CreditsPage } from "../credits/CreditsPage.tsx";
import type { DataStatus } from "../motion/protocol.ts";
import { initialState, useAppStore } from "../state/store.ts";
import { SkipLink } from "./SkipLink.tsx";

const STATUS: DataStatus = {
  state: "live",
  dataTimeMs: Date.parse("2026-10-23T19:34:00Z"),
  trips: 2665,
  realtime: 2234,
  untracked: 37,
  counts: { hsr: 151, ld: 40, night: 3, rfast: 463, reg: 610, sbahn: 621, foreign: 777 },
  delayCounts: { ok: 2000, minor: 300, major: 100, severe: 20, none: 245, foreign: 777 },
  operatorCounts: {
    db: 1600,
    transdev: 140,
    kvvh: 90,
    netinera: 80,
    hlb: 60,
    sweg: 40,
    other: 550,
    unknown: 55,
  },
  error: undefined,
};

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  await changeLocale("en");
  useAppStore.setState({ ...initialState(), status: STATUS });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function clean(element: React.ReactElement) {
  const { container } = render(element);
  expect(await axeViolations(container)).toEqual([]);
}

describe("shell controls have no axe violations", () => {
  it("search card, phone and desktop", async () => {
    await clean(<SearchCard />);
    cleanup();
    await clean(<SearchCard compact />);
  });

  it("live bar, in every data state and stacked", async () => {
    for (const state of ["live", "recorded", "stale", "loading", "error"] as const) {
      useAppStore.setState({ status: { ...STATUS, state } });
      await clean(<LiveBar />);
      cleanup();
    }
    await clean(<LiveBar stacked />);
  });

  it("zoom controls and the language switch", async () => {
    await clean(<ZoomControls onZoom={() => undefined} />);
    cleanup();
    await clean(<LocaleSwitch />);
  });

  it("style picker on every style, with the terrain switches", async () => {
    for (const mapStyle of ["dark", "light", "satellite", "terrain"] as const) {
      useAppStore.setState({ mapStyle, terrain3d: mapStyle === "terrain", buildings: true });
      await clean(<StylePicker />);
      cleanup();
    }
  });

  it("legend card collapsed, open, and in delay mode", async () => {
    await clean(<LegendCard collapsible defaultOpen={false} />);
    cleanup();
    await clean(<LegendCard collapsible defaultOpen />);
    cleanup();
    useAppStore.setState({ colourMode: "delay" });
    await clean(<LegendCard />);
  });

  it("legend card in operator mode: counts, a hidden group, counts missing, collapsed and phone", async () => {
    useAppStore.setState({ colourMode: "operator" });
    await clean(<LegendCard />);
    cleanup();
    useAppStore.setState({ hiddenOperatorGroups: ["db", "unknown"] });
    await clean(<LegendCard />);
    cleanup();
    const { operatorCounts: _counts, ...withoutCounts } = STATUS;
    useAppStore.setState({ status: withoutCounts });
    await clean(<LegendCard />);
    cleanup();
    useAppStore.setState({ status: STATUS });
    await clean(<LegendCard collapsible defaultOpen={false} />);
    cleanup();
    await clean(<LegendCard collapsible defaultOpen />);
  });

  it("colour mode tabs in every mode, and in German and Polish", async () => {
    for (const colourMode of ["category", "delay", "operator"] as const) {
      useAppStore.setState({ colourMode });
      await clean(<SearchCard />);
      cleanup();
    }
    for (const locale of ["de", "pl"] as const) {
      await changeLocale(locale);
      useAppStore.setState({ colourMode: "operator" });
      await clean(<LegendCard />);
      cleanup();
      await clean(<SearchCard />);
      cleanup();
    }
  });

  it("keeps the legend title a heading when the card collapses", () => {
    render(<LegendCard collapsible defaultOpen={false} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(within(heading).getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("the chip of a focused Land", async () => {
    useAppStore.setState({ focusLand: "DE-BY" });
    await clean(<LandChip />);
  });
});

describe("whole shells have no axe violations and keep their landmarks", () => {
  function page(shell: React.ReactElement) {
    return (
      <main>
        <SkipLink />
        {shell}
      </main>
    );
  }

  it("desktop shell", async () => {
    const { container } = render(page(<DesktopShell onZoom={() => undefined} />));
    expect(await axeViolations(container, { page: true })).toEqual([]);
  });

  it("phone shell", async () => {
    const { container } = render(page(<PhoneShell />));
    expect(await axeViolations(container, { page: true })).toEqual([]);
  });

  it("phone shell shows the colour key of the active mode above the live bar at the first paint", () => {
    useAppStore.setState({ ...initialState() });
    const { container } = render(page(<PhoneShell />));
    const key = container.querySelector("[data-slot=colour-key]");
    const bar = container.querySelector("[data-slot=live-bar]");
    expect(key?.getAttribute("data-mode")).toBe("category");
    expect(
      key && bar && key.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("attribution, open and collapsed", async () => {
    await clean(<Attribution />);
    cleanup();
    await clean(<Attribution collapsible />);
  });
});

describe("overlays and pages have no axe violations", () => {
  it("the layers popover on a phone, closed and open, returns the focus on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<LayersPopover />);
    expect(await axeViolations(container)).toEqual([]);
    const trigger = screen.getByRole("button", { name: "Map layers" });
    await user.click(trigger);
    await waitFor(() => expect(document.querySelector("[data-slot=popover-content]")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Map layers" })).toBe(trigger);
    expect(await axeViolations(document.body)).toEqual([]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[data-slot=popover-content]")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("the map failure notice", async () => {
    await clean(<MapFailure onReload={() => undefined} />);
  });

  it("the photo credits page with photos and without", async () => {
    const photo = {
      photoId: "db-403-p1",
      seriesId: "db-403",
      seriesName: "ICE 3",
      small: { url: "/api/v1/photos/db-403-p1-330-0123456789ab.jpg", width: 330, height: 220 },
      large: { url: "/api/v1/photos/db-403-p1-960-0123456789ab.jpg", width: 960, height: 640 },
      focus: { x: 0.5, y: 0.5 },
      title: "ICE 3 in Köln.JPG",
      author: "Rail Fan",
      authorUrl: "https://commons.wikimedia.org/wiki/User:Rail_Fan",
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:ICE_3.jpg",
    };
    const answer = (photos: unknown[]) => async () =>
      new Response(JSON.stringify({ photos }), { status: 200 });
    const full = render(<CreditsPage fetcher={answer([photo])} />);
    await screen.findByRole("heading", { name: "ICE 3" });
    expect(await axeViolations(full.container, { page: true })).toEqual([]);
    cleanup();
    const empty = render(<CreditsPage fetcher={answer([])} />);
    await waitFor(() => expect(empty.container.querySelector("h1")).toBeTruthy());
    expect(await axeViolations(empty.container, { page: true })).toEqual([]);
  });
});
