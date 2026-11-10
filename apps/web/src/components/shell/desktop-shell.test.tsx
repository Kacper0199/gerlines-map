// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changeLocale } from "@gerlines/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore } from "../../playback/store.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { BESIDE_ZOOM_COLUMN, DesktopShell } from "./DesktopShell.tsx";

const MEASURED_CLEARANCE = "pb-[calc(var(--gl-live-bar-h,var(--gl-target))+var(--gl-s3))]";

beforeEach(async () => {
  await changeLocale("en");
  useAppStore.setState(initialState());
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as never,
  );
});
afterEach(() => {
  cleanup();
  usePlaybackStore.setState({ panelOpen: false, state: null });
  vi.unstubAllGlobals();
});

function leftColumn(container: HTMLElement): HTMLElement {
  return container.querySelector(".col-start-1.row-start-1") as HTMLElement;
}

describe("DesktopShell bottom row", () => {
  function stubCompact(compact: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: compact,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as never,
    );
  }
  const row = (container: HTMLElement) =>
    container.querySelector("[data-slot=bottom-row]") as HTMLElement;
  const bar = (container: HTMLElement) =>
    container.querySelector("[data-slot=live-bar]") as HTMLElement;

  it("keeps the live bar clear of the attribution card above compact sizes: capped, and from 1280 px centred only while the free side keeps the card's room", () => {
    stubCompact(false);
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    expect(bar(container).className.split(" ")).toContain("max-w-[calc(100vw-426px)]");
    expect(row(container).className.split(" ")).toContain(
      "min-[1280px]:grid-cols-[minmax(0,1fr)_auto_minmax(24.625rem,1fr)]",
    );
  });

  it("only leaves room for the zoom column on a compact screen, where the attribution is a button", () => {
    stubCompact(true);
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    expect(bar(container).className.split(" ")).toContain(BESIDE_ZOOM_COLUMN);
    expect(row(container).className.split(" ")).toContain(
      "min-[1280px]:grid-cols-[minmax(0,1fr)_auto_minmax(3.5rem,1fr)]",
    );
  });
});

describe("DesktopShell left column", () => {
  it("runs under the live bar, down to the bottom of the grid, while no timeline is open", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);

    const classes = leftColumn(container).className.split(" ");
    expect(classes).toContain("row-end-3");
    expect(classes.some((name) => name.startsWith("row-span-"))).toBe(false);
  });

  it("stops above the timeline below 1040 px while it is open, runs beside it from 1040 to 1279 px and from 1650 px, and never uses a row span that would drop its start row", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    act(() => usePlaybackStore.setState({ panelOpen: true }));

    const classes = leftColumn(container).className.split(" ");
    expect(classes).toContain("row-end-2");
    expect(classes).toContain("min-[1040px]:max-[1279px]:row-end-3");
    expect(classes).toContain("min-[1650px]:row-end-3");
    expect(classes.some((name) => /(^|:)row-span-/.test(name))).toBe(false);
  });

  it("stops above the whole bottom stack from 1280 to 1649 px while the timeline is open, where the centred timeline lies under the column's lower right", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    act(() => usePlaybackStore.setState({ panelOpen: true }));

    const classes = leftColumn(container).className.split(" ");
    expect(classes).not.toContain("min-[1040px]:row-end-3");
    expect(classes).not.toContain("min-[1280px]:row-end-3");
    expect(classes.filter((name) => name.endsWith("row-end-3"))).toEqual([
      "min-[1040px]:max-[1279px]:row-end-3",
      "min-[1650px]:row-end-3",
    ]);
  });

  it("stops above the live bar below 1040 px while a playback runs with the timeline closed, since the bar may wrap into two rows", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    act(() =>
      usePlaybackStore.setState({
        panelOpen: false,
        state: {
          phase: "playing",
          playing: true,
          position: 1,
          speed: 1,
          windowStart: 0,
          windowEnd: 3600,
          error: null,
          notice: null,
        },
      }),
    );

    const classes = leftColumn(container).className.split(" ");
    expect(classes).toContain("row-end-2");
    expect(classes).toContain("min-[1040px]:max-[1279px]:row-end-3");
  });
});

describe("DesktopShell left column under a bar that wraps", () => {
  type Observed = { callback: () => void; targets: Element[] };
  let observers: Observed[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        record: Observed;
        constructor(callback: () => void) {
          this.record = { callback, targets: [] };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        disconnect() {
          this.record.targets = [];
        }
        unobserve() {}
      },
    );
  });

  const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  const bar = (container: HTMLElement) =>
    container.querySelector("[data-slot=live-bar]") as HTMLElement;
  function resizeBar(container: HTMLElement, height: number) {
    const element = bar(container);
    element.getBoundingClientRect = () => ({ height }) as DOMRect;
    act(() => {
      for (const observer of observers) {
        if (observer.targets.includes(element)) observer.callback();
      }
    });
  }

  it("pads the column by the measured height of the bar, so a bar of two rows is never drawn over its content", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);

    expect(leftColumn(container).className.split(" ")).toContain(MEASURED_CLEARANCE);
    resizeBar(container, 86);
    expect(root(container).style.getPropertyValue("--gl-live-bar-h")).toBe("86px");
    resizeBar(container, 44);
    expect(root(container).style.getPropertyValue("--gl-live-bar-h")).toBe("44px");
  });

  it("writes the variant class out whole in the source, since Tailwind only generates classes it finds as literal strings", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/shell/DesktopShell.tsx"),
      "utf8",
    );

    expect(source).toContain(`min-[1040px]:max-[1279px]:${MEASURED_CLEARANCE}`);
    expect(source).toContain(`min-[1650px]:${MEASURED_CLEARANCE}`);
    expect(source).toContain(` ${MEASURED_CLEARANCE}`);
  });

  it("measures the bar it is given and removes the variable and the observer when the shell goes", () => {
    const { container, unmount } = render(<DesktopShell onZoom={() => {}} />);
    const element = root(container);
    resizeBar(container, 60);
    expect(element.style.getPropertyValue("--gl-live-bar-h")).toBe("60px");

    unmount();

    expect(element.style.getPropertyValue("--gl-live-bar-h")).toBe("");
    expect(observers.every((observer) => observer.targets.length === 0)).toBe(true);
  });

  it("observes the border box, so a padding change at a constant content height still updates the variable", () => {
    const options: unknown[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(_callback: () => void) {}
        observe(_target: Element, option?: unknown) {
          options.push(option);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    render(<DesktopShell onZoom={() => {}} />);

    expect(options).toContainEqual({ box: "border-box" });
  });

  it("keeps the measured padding from 1040 px while a playback runs, where the timeline sits beside the card slot", () => {
    const { container } = render(<DesktopShell onZoom={() => {}} />);
    act(() => usePlaybackStore.setState({ panelOpen: true }));

    const classes = leftColumn(container).className.split(" ");
    expect(classes).toContain("min-[1040px]:max-[1279px]:row-end-3");
    expect(classes).toContain(`min-[1040px]:max-[1279px]:${MEASURED_CLEARANCE}`);
    expect(classes).toContain(`min-[1650px]:${MEASURED_CLEARANCE}`);
  });
});

describe("DesktopShell attribution beside an open timeline", () => {
  function stubWidth({ compact, narrow }: { compact: boolean; narrow: boolean }) {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("1100px") ? compact : query.includes("1280px") ? narrow : false,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as never,
    );
  }
  const infoButton = () => screen.queryByRole("button", { name: /^(Show|Hide) data sources$/ });

  it("keeps the credits open at 1101 to 1279 px while no timeline is open", () => {
    stubWidth({ compact: false, narrow: true });
    render(<DesktopShell onZoom={() => {}} />);

    expect(infoButton()).toBeNull();
    expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
  });

  it("folds them to the info button while the timeline is open at 1101 to 1279 px, since the card would hide the Hour select", () => {
    stubWidth({ compact: false, narrow: true });
    render(<DesktopShell onZoom={() => {}} />);

    act(() => usePlaybackStore.setState({ panelOpen: true }));
    expect(infoButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "DELFI" })).toBeNull();

    act(() => usePlaybackStore.setState({ panelOpen: false }));
    expect(infoButton()).toBeNull();
    expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();
  });

  it("folds them on a compact screen too (1040 to 1100 px) the moment the timeline opens, without waiting for the timer", () => {
    stubWidth({ compact: true, narrow: true });
    render(<DesktopShell onZoom={() => {}} />);
    expect(screen.getByRole("link", { name: "DELFI" })).toBeTruthy();

    act(() => usePlaybackStore.setState({ panelOpen: true }));

    expect(screen.queryByRole("link", { name: "DELFI" })).toBeNull();
    expect(infoButton()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the credits open from 1280 px, where the timeline sits in the middle track clear of the corner", () => {
    stubWidth({ compact: false, narrow: false });
    render(<DesktopShell onZoom={() => {}} />);

    act(() => usePlaybackStore.setState({ panelOpen: true }));
    expect(infoButton()).toBeNull();
  });
});
