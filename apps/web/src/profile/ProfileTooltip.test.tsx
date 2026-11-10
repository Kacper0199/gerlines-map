// @vitest-environment happy-dom
import { TrainDetail } from "@gerlines/schema";
import { StatsTrainSegments } from "@gerlines/schema/stats";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileTooltipHost } from "../components/ProfileTooltipHost.tsx";
import ice from "../components/train/fixtures/ice-delay.json" with { type: "json" };
import { SelectedTrain } from "../components/train/SelectedTrain.tsx";
import { useAppStore } from "../state/store.ts";
import answerJson from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { buildProfileLegs } from "./model.ts";
import { profileSubjectOf } from "./subject.ts";
import { HOLD_MS } from "./use-held-hover.ts";

const detail = TrainDetail.parse(ice.detail);
const stops = profileSubjectOf(detail, true)?.stops ?? [];
const { legs } = buildProfileLegs(
  stops,
  StatsTrainSegments.parse(answerJson),
  Float32Array.from(stops.map((_, i) => i)),
);

const TOOLTIP = "[data-slot=profile-tooltip]";

async function tooltipShown(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(TOOLTIP);
      if (found === null) throw new Error("no tooltip yet");
      return found;
    },
    { timeout: 10_000 },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pointAtLeg(): void {
  const store = useAppStore.getState();
  store.select("live:1");
  store.setProfile({ legs, quantile: "median" });
  store.setProfileHover({ leg: 2, x: 100, y: 120 });
}

afterEach(() => {
  cleanup();
  useAppStore.getState().select(null);
});

describe("ProfileTooltipHost", () => {
  it("shows nothing until a leg is pointed at", () => {
    useAppStore.getState().select("live:1");
    render(<ProfileTooltipHost />);
    expect(document.querySelector(TOOLTIP)).toBeNull();
  });

  it("shows the figures of the pointed leg and of all trains, as in the card list", async () => {
    const store = useAppStore.getState();
    store.select("live:1");
    store.setProfile({ legs, quantile: "median" });
    store.setProfileHover({ leg: 2, x: 100, y: 120 });
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    expect(tooltip.textContent).toContain("Hamburg Hbf to Hamburg-Harburg");
    expect(tooltip.textContent).toContain("Median 1 min, 8 in 10 under 2 min, 24 runs");
    expect(tooltip.textContent).toContain("All trains");
    expect(tooltip.textContent).toContain("Same as all trains");
  });

  it("says why a leg has no figures", async () => {
    const store = useAppStore.getState();
    store.select("live:1");
    store.setProfile({ legs, quantile: "median" });
    store.setProfileHover({ leg: 3, x: 100, y: 120 });
    render(<ProfileTooltipHost />);
    expect((await tooltipShown()).textContent).toContain("Too few runs: 3, at least 5 are needed");
  });

  it("is not a live region, so pointing around the map announces nothing", async () => {
    const store = useAppStore.getState();
    store.select("live:1");
    store.setProfile({ legs, quantile: "median" });
    store.setProfileHover({ leg: 2, x: 100, y: 120 });
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    expect(tooltip.getAttribute("role")).toBeNull();
    expect(tooltip.closest("[aria-live]")).toBeNull();
  });

  it("goes away with Escape", async () => {
    const store = useAppStore.getState();
    store.select("live:1");
    store.setProfile({ legs, quantile: "median" });
    store.setProfileHover({ leg: 2, x: 100, y: 120 });
    render(<ProfileTooltipHost />);
    await tooltipShown();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull());
    expect(useAppStore.getState().profileHover).toBeNull();
  });

  it("takes the first Escape for itself and leaves the train card open until the second", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const store = useAppStore.getState();
    store.select("live:1");
    store.setProfile({ legs, quantile: "median" });
    store.setProfileHover({ leg: 2, x: 100, y: 120 });
    render(
      <>
        <SelectedTrain phone={false} />
        <ProfileTooltipHost />
      </>,
    );
    await tooltipShown();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull());
    expect(useAppStore.getState().selectedId).toBe("live:1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().selectedId).toBeNull();
    vi.unstubAllGlobals();
  });

  it("can be hovered: it takes pointer events and stays while the pointer crosses the gap to it", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    expect(tooltip.className).not.toContain("pointer-events-none");
    act(() => useAppStore.getState().setProfileHover(null));
    expect(document.querySelector(TOOLTIP)).not.toBeNull();
    fireEvent.pointerEnter(tooltip);
    await act(() => sleep(HOLD_MS + 300));
    expect(document.querySelector(TOOLTIP)).not.toBeNull();
  });

  it("stays while the pointer is over it, then goes shortly after the pointer leaves", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    fireEvent.pointerEnter(tooltip);
    act(() => useAppStore.getState().setProfileHover(null));
    await act(() => sleep(HOLD_MS + 300));
    expect(document.querySelector(TOOLTIP)).not.toBeNull();
    fireEvent.pointerLeave(tooltip);
    expect(document.querySelector(TOOLTIP)).not.toBeNull();
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull(), { timeout: 2000 });
  });

  it("goes when the pointer left the leg and never reached the tooltip", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    await tooltipShown();
    act(() => useAppStore.getState().setProfileHover(null));
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull(), { timeout: 2000 });
  });

  it("goes with Escape even while the pointer is over it", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    fireEvent.pointerEnter(tooltip);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull());
  });

  it("follows the pointer to another leg without waiting", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    await tooltipShown();
    act(() => useAppStore.getState().setProfileHover({ leg: 3, x: 140, y: 150 }));
    await waitFor(() =>
      expect(document.querySelector(TOOLTIP)?.textContent).toContain("Too few runs"),
    );
  });

  it("is not stuck as hovered when it vanishes under a resting pointer: the next tooltip still goes", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    const tooltip = await tooltipShown();
    fireEvent.pointerEnter(tooltip);
    act(() => useAppStore.getState().setProfile(null));
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull());
    act(() => {
      useAppStore.getState().setProfile({ legs, quantile: "median" });
      useAppStore.getState().setProfileHover({ leg: 2, x: 100, y: 120 });
    });
    await tooltipShown();
    act(() => useAppStore.getState().setProfileHover(null));
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull(), { timeout: 2000 });
  });

  it("leaves Escape to the card behind it when nothing is drawn", async () => {
    pointAtLeg();
    render(<ProfileTooltipHost />);
    await tooltipShown();
    act(() => useAppStore.getState().setProfile(null));
    await waitFor(() => expect(document.querySelector(TOOLTIP)).toBeNull());
    const notPrevented = fireEvent.keyDown(window, { key: "Escape", cancelable: true });
    expect(notPrevented).toBe(true);
  });
});
