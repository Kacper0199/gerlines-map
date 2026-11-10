// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCardFocus, takeCardFocus } from "../../a11y/card-focus.ts";
import type { DataStatus, LiveSelectionInfo } from "../../motion/protocol.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { FrameTrainCard } from "./FrameTrainCard.tsx";
import { frameTrainNaming } from "./train-naming.ts";

const NOW = Date.parse("2026-10-25T16:00:00Z");

const INFO: LiveSelectionInfo = {
  key: 25714801,
  line: "ICE",
  trainNumber: 379,
  category: "hsr",
  foreign: false,
  realtime: true,
  delaySeconds: 360,
  dataTimeMs: NOW,
  speedMps: null,
};

const STATUS: DataStatus = {
  state: "recorded",
  dataTimeMs: NOW,
  trips: 10,
  realtime: 8,
  untracked: 0,
  counts: { hsr: 1, ld: 0, night: 0, rfast: 0, reg: 0, sbahn: 0, foreign: 0 },
  error: undefined,
};

function show(
  info: LiveSelectionInfo | null,
  extra: Partial<ReturnType<typeof initialState>> = {},
) {
  useAppStore.setState({
    ...initialState(),
    selectedId: "live:25714801",
    liveSelection: info,
    status: STATUS,
    ...extra,
  });
}

const LABELS = {
  line: (line: string) => `Line ${line}`,
  trainNumber: (number: string) => `Train ${number}`,
};

function naming(over: Partial<LiveSelectionInfo>) {
  return frameTrainNaming({ ...INFO, ...over }, LABELS);
}

describe("frameTrainNaming", () => {
  it("joins a line of letters with the train number", () => {
    expect(naming({})).toEqual({ title: "ICE 379", subtitle: null });
  });

  it("never invents a product for a line of digits: Train and the number, the line below", () => {
    expect(naming({ line: "12", trainNumber: 953 })).toEqual({
      title: "Train 953",
      subtitle: "Line 12",
    });
    expect(naming({ category: "ld", line: "82", trainNumber: 9553 })).toEqual({
      title: "Train 9553",
      subtitle: "Line 82",
    });
    expect(naming({ category: "ld", line: "17", trainNumber: 177 })).toEqual({
      title: "Train 177",
      subtitle: "Line 17",
    });
  });

  it("takes the product from a line that starts with letters", () => {
    expect(naming({ category: "ld", line: "IC35", trainNumber: 52200 })).toEqual({
      title: "IC 52200",
      subtitle: "Line IC35",
    });
    expect(naming({ category: "ld", line: "FLX10", trainNumber: null })).toEqual({
      title: "FLX10",
      subtitle: null,
    });
  });

  it("never titles a long distance train with a bare number or a bare line number", () => {
    expect(naming({ category: "night", line: "40", trainNumber: 295 })).toEqual({
      title: "Train 295",
      subtitle: "Line 40",
    });
    expect(naming({ line: "12", trainNumber: null })).toEqual({ title: "Line 12", subtitle: null });
    expect(naming({ line: null, trainNumber: 953 })).toEqual({
      title: "Train 953",
      subtitle: null,
    });
  });

  it("keeps a regional line and shows its train number below", () => {
    expect(naming({ category: "reg", line: "RE 1", trainNumber: 4711 })).toEqual({
      title: "RE 1",
      subtitle: "Train 4711",
    });
    expect(naming({ category: "sbahn", line: "S1", trainNumber: 4711 })).toEqual({
      title: "S1",
      subtitle: "Train 4711",
    });
    expect(naming({ category: "rfast", line: "MEX12", trainNumber: null })).toEqual({
      title: "MEX12",
      subtitle: null,
    });
  });

  it("joins a regional line of letters with its train number", () => {
    expect(naming({ category: "reg", line: "DRB", trainNumber: 375 })).toEqual({
      title: "DRB 375",
      subtitle: null,
    });
  });

  it("writes a regional line of digits as a line, not as a bare number", () => {
    expect(naming({ category: "reg", line: "527", trainNumber: 1800002 })).toEqual({
      title: "Line 527",
      subtitle: "Train 1800002",
    });
  });

  it("falls back to the train number with its word, or to nothing", () => {
    expect(naming({ category: "reg", line: null })).toEqual({ title: "Train 379", subtitle: null });
    expect(naming({ category: "foreign", line: "", trainNumber: 12 })).toEqual({
      title: "Train 12",
      subtitle: null,
    });
    expect(naming({ line: null, trainNumber: null, category: "reg" })).toEqual({
      title: null,
      subtitle: null,
    });
  });

  it("never gives a bare number as the title for any category and line shape", () => {
    const categories = ["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"] as const;
    const lines = [null, "", "12", "ICE", "IC35", "RE1", "S5X", "RB42a", "A1", "FLX10"];
    for (const category of categories) {
      for (const line of lines) {
        for (const trainNumber of [null, 953, 69749]) {
          const { title } = naming({ category, line, trainNumber });
          expect(title === null || /\D/.test(title)).toBe(true);
        }
      }
    }
  });
});

describe("SelectedTrain for a train from our frames", () => {
  beforeEach(() => show(INFO));
  afterEach(cleanup);

  it("takes the focus on its heading when the trains in view list opened it", () => {
    takeCardFocus();
    requestCardFocus("live:25714801");
    render(<FrameTrainCard phone={false} />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "ICE 379" }));
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("leaves the focus alone when a map click opened it", () => {
    takeCardFocus();
    render(<FrameTrainCard phone={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows service, title, delay and realtime on the desktop card", () => {
    render(<FrameTrainCard phone={false} />);

    expect(screen.getByRole("heading", { name: "ICE 379" })).toBeTruthy();
    expect(screen.getByText("Realtime")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Selected train" })).toBeTruthy();
    expect(document.body.textContent).toContain("6");
  });

  it("says where the position comes from and that the data is recorded", () => {
    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText(/Position is estimated between reports/)).toBeTruthy();
    expect(
      screen.getByText(/This is a recorded sample from that date, not live data\./),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("moved to the present");
  });

  it("does not claim a recorded sample was moved when no data time is known", () => {
    show(INFO, { status: { ...STATUS, dataTimeMs: undefined } });

    render(<FrameTrainCard phone={false} />);

    expect(document.body.textContent).not.toContain("recorded sample");
  });

  it("shows the live sentence set only for recorded data", () => {
    show(INFO, { status: { ...STATUS, state: "live" } });

    render(<FrameTrainCard phone={false} />);

    expect(document.body.textContent).not.toContain("recorded sample");
  });

  it("says updating failed and drops the Realtime caption when the server cannot be read", () => {
    show(INFO, { status: { ...STATUS, state: "error", error: "unreachable" } });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText(/Updating failed, trying again\./)).toBeTruthy();
    expect(screen.queryByText("Realtime")).toBeNull();
  });

  it("shows a hollow stale caption instead of Realtime for stale data", () => {
    show(INFO, { status: { ...STATUS, state: "stale" } });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText("Data is stale")).toBeTruthy();
    expect(screen.queryByText("Realtime")).toBeNull();
  });

  it("labels the frame's delay as the delay now, not a stop's", () => {
    render(<FrameTrainCard phone={false} />);
    expect(document.querySelector("header")?.textContent).toContain("Now +6");
    cleanup();
    show({ ...INFO, delaySeconds: 20 });
    render(<FrameTrainCard phone={false} />);
    expect(document.querySelector("header")?.textContent).not.toContain("Now");
    cleanup();
    show({ ...INFO, realtime: false, delaySeconds: null });
    render(<FrameTrainCard phone={false} />);
    expect(document.querySelector("header")?.textContent).not.toContain("Now");
  });

  it("mutes No data for a timetable only train", () => {
    show({ ...INFO, realtime: false, delaySeconds: null });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText("No data").closest("span.inline-block")?.className).toContain(
      "text-ink-muted",
    );
  });

  it("keeps the delay in ink for a realtime train", () => {
    render(<FrameTrainCard phone={false} />);

    const delay = screen.getByText(/^\+?6$/).closest("span.inline-block");
    expect(delay?.className).not.toContain("text-ink-muted");
  });

  it("shows a timetable only train without a delay claim", () => {
    show({ ...INFO, realtime: false, delaySeconds: null });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText("Timetable only")).toBeTruthy();
  });

  it("shows the provenance of a timetable only train without a data time and without reports", () => {
    show({ ...INFO, realtime: false, delaySeconds: null });

    render(<FrameTrainCard phone={false} />);

    expect(document.body.textContent).not.toContain("Data from");
    expect(document.body.textContent).not.toContain("estimated between reports");
    expect(screen.getByText(/There is no realtime data for this train/)).toBeTruthy();
  });

  it("falls back to the generic title without line and number", () => {
    show({ ...INFO, line: null, trainNumber: null });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByRole("heading", { name: "Train" })).toBeTruthy();
  });

  it("explains a train that left the data and offers to close", () => {
    show(null, { selectionEnded: true });

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText("This train is no longer in the data.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close train card" })).toBeTruthy();
  });

  it("shows loading before the first report arrives", () => {
    show(null);

    render(<FrameTrainCard phone={false} />);

    expect(screen.getByText("Loading trains")).toBeTruthy();
  });

  it("closes from the button", () => {
    render(<FrameTrainCard phone={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Close train card" }));

    expect(useAppStore.getState().selectedId).toBeNull();
  });

  it("renders in the phone sheet without a handle and tells the layout its height", () => {
    const { unmount } = render(<FrameTrainCard phone />);

    expect(screen.getByRole("heading", { name: "ICE 379" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more of this train" })).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--gl-sheet-peek")).toBe("224px");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--gl-sheet-peek")).toBe("");
  });

  it("follows the measured height of the sheet, also when the train arrives after the mount", () => {
    let notify: () => void = () => undefined;
    class FakeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 208.4 } as DOMRect);
    show(null);
    const { unmount } = render(<FrameTrainCard phone />);
    show(INFO);
    notify();

    expect(document.documentElement.style.getPropertyValue("--gl-sheet-peek")).toBe("209px");
    unmount();
    measure.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows no forbidden characters in anything it renders", () => {
    render(<FrameTrainCard phone={false} />);

    expect(document.body.textContent ?? "").not.toMatch(/--|\/|["';·]/);
  });
});
