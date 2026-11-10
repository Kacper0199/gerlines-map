// @vitest-environment happy-dom
import { buildMotionPlan, CATEGORY_DYNAMICS, planSpeed } from "@gerlines/geo";
import { changeLocale, type Locale } from "@gerlines/i18n";
import { TooltipProvider } from "@gerlines/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStatus, LiveSelectionInfo } from "../../motion/protocol.ts";
import { initialState, useAppStore } from "../../state/store.ts";
import { TrainPanel, TrainSheet } from "./card/TrainCard.tsx";
import { FrameTrainCard } from "./FrameTrainCard.tsx";
import { roundedSpeedKmh, SelectedSpeed, SpeedEstimate, shownSpeedKmh } from "./SpeedRow.tsx";
import { MINUTE, T0, testDetail } from "./test-detail.ts";

const NOW = T0 + 30 * MINUTE;
const KMH = 1 / 3.6;
const NO_BREAK_SPACE = " ";

const INFO: LiveSelectionInfo = {
  key: 17,
  line: "ICE",
  trainNumber: 541,
  category: "hsr",
  foreign: false,
  realtime: true,
  delaySeconds: 360,
  dataTimeMs: NOW,
  speedMps: 123 * KMH,
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

function select(info: LiveSelectionInfo | null, selectedId: string | null = "live:17") {
  useAppStore.setState({ ...initialState(), selectedId, liveSelection: info, status: STATUS });
}

beforeEach(() => select(INFO));

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

describe("roundedSpeedKmh", () => {
  it("rounds to the nearest 5 km/h", () => {
    expect(roundedSpeedKmh(0)).toBe(0);
    expect(roundedSpeedKmh(2.4 * KMH)).toBe(0);
    expect(roundedSpeedKmh(2.6 * KMH)).toBe(5);
    expect(roundedSpeedKmh(123 * KMH)).toBe(125);
    expect(roundedSpeedKmh(121 * KMH)).toBe(120);
    expect(roundedSpeedKmh(300 * KMH)).toBe(300);
  });

  it("is a multiple of 5 within 2.5 km/h of the speed, whatever the speed", () => {
    for (let step = 0; step <= 3000; step++) {
      const mps = step / 30;
      const rounded = roundedSpeedKmh(mps);
      expect(rounded % 5).toBe(0);
      expect(Math.abs(rounded - mps * 3.6)).toBeLessThanOrEqual(2.5 + 1e-9);
    }
  });
});

describe("shownSpeedKmh", () => {
  it("is 0 only for a speed of exactly 0 and at least 5 for any movement", () => {
    expect(shownSpeedKmh(0)).toBe(0);
    expect(shownSpeedKmh(1e-9)).toBe(5);
    expect(shownSpeedKmh(1 * KMH)).toBe(5);
    expect(shownSpeedKmh(123 * KMH)).toBe(125);
  });
});

describe("SpeedEstimate", () => {
  it("shows the rounded speed as an estimate with its realtime basis", () => {
    render(<SpeedEstimate speedMps={123 * KMH} realtime />);
    expect(screen.getByRole("region", { name: "Speed estimate" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Speed estimate" })).toBeTruthy();
    expect(screen.getByText(`125${NO_BREAK_SPACE}km/h`)).toBeTruthy();
    expect(screen.getByText("From the timetable and the latest realtime report.")).toBeTruthy();
  });

  it("says the basis is the timetable only for a train without realtime data", () => {
    render(<SpeedEstimate speedMps={80 * KMH} realtime={false} />);
    expect(screen.getByText("From the timetable only.")).toBeTruthy();
    expect(screen.queryByText(/realtime report/)).toBeNull();
  });

  it("names the report of that moment as the basis in a playback", () => {
    render(<SpeedEstimate speedMps={80 * KMH} realtime playback />);
    expect(
      screen.getByText("From the timetable and the report known at that moment."),
    ).toBeTruthy();
    cleanup();
    render(<SpeedEstimate speedMps={80 * KMH} realtime={false} playback />);
    expect(screen.getByText("From the timetable only.")).toBeTruthy();
  });

  it("says the train stands at a station instead of showing 0 km/h", () => {
    render(<SpeedEstimate speedMps={0} realtime />);
    expect(screen.getByText("Standing at a station")).toBeTruthy();
    expect(document.body.textContent).not.toContain("km/h");
  });

  it("never says standing for a train that moves, however slowly its stretched leg runs", () => {
    const stretched = buildMotionPlan({
      stops: [
        { s: 0, departure: 0 },
        { s: 2000, arrival: 3600 },
      ],
      dynamics: CATEGORY_DYNAMICS.reg,
    });
    const speed = planSpeed(stretched, 1800) as number;
    expect(speed).toBeGreaterThan(0);
    expect(roundedSpeedKmh(speed)).toBe(0);
    render(<SpeedEstimate speedMps={speed} realtime />);
    expect(screen.queryByText("Standing at a station")).toBeNull();
    expect(screen.getByText(`5${NO_BREAK_SPACE}km/h`)).toBeTruthy();
  });

  it("has no row without a plan to evaluate", () => {
    const { container } = render(<SpeedEstimate speedMps={null} realtime />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const bad = render(<SpeedEstimate speedMps={Number.NaN} realtime />);
    expect(bad.container.innerHTML).toBe("");
  });

  it.each<[Locale, string, string, string, string]>([
    [
      "de",
      "Geschwindigkeit, geschätzt",
      `125${NO_BREAK_SPACE}km/h`,
      "Aus dem Fahrplan und der letzten Echtzeitmeldung.",
      "Steht im Bahnhof",
    ],
    [
      "pl",
      "Szacowana prędkość",
      `125${NO_BREAK_SPACE}km/godz.`,
      "Z rozkładu jazdy i ostatniego raportu czasu rzeczywistego.",
      "Stoi na stacji",
    ],
  ])("is worded in %s", async (locale, label, value, basis, standing) => {
    await changeLocale(locale, { persist: false });
    render(<SpeedEstimate speedMps={123 * KMH} realtime />);
    expect(screen.getByRole("heading", { level: 3, name: label })).toBeTruthy();
    expect(screen.getByText(value)).toBeTruthy();
    expect(screen.getByText(basis)).toBeTruthy();
    cleanup();
    render(<SpeedEstimate speedMps={0} realtime />);
    expect(screen.getByText(standing)).toBeTruthy();
  });

  it("uses no punctuation the copy rules forbid", async () => {
    const forbidden = /--|[/;"“”„«»·]/;
    for (const locale of ["en", "de", "pl"] as const) {
      await changeLocale(locale, { persist: false });
      for (const [mps, realtime] of [
        [0, true],
        [30, true],
        [30, false],
      ] as const) {
        render(<SpeedEstimate speedMps={mps} realtime={realtime} />);
        const text = [...document.body.querySelectorAll("h3, p, span")]
          .map((element) => element.textContent ?? "")
          .filter((content) => !/\d/.test(content))
          .join(" ");
        expect(text).not.toMatch(forbidden);
        cleanup();
      }
    }
  });
});

describe("SelectedSpeed", () => {
  it("reads the speed of the selected train from the worker's selection", () => {
    render(<SelectedSpeed />);
    expect(screen.getByText(`125${NO_BREAK_SPACE}km/h`)).toBeTruthy();
  });

  it("shows nothing before the first selection update", () => {
    select(null);
    const { container } = render(<SelectedSpeed />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing for the update of another train", () => {
    select({ ...INFO, key: 18 });
    const { container } = render(<SelectedSpeed />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing when the selected train is not one of our frames", () => {
    select(INFO, "20261024_12:00_de-DELFI_a");
    const { container } = render(<SelectedSpeed />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing for a plan that ended", () => {
    select({ ...INFO, speedMps: null });
    const { container } = render(<SelectedSpeed />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the speed row in the train cards", () => {
  it("is in the frame card, also in a playback", () => {
    render(<FrameTrainCard phone={false} playback />);
    expect(screen.getByText(`125${NO_BREAK_SPACE}km/h`)).toBeTruthy();
    expect(screen.getByText(/report known at that moment/)).toBeTruthy();
  });

  it("is not in the frame card of a train whose plan ended", () => {
    select({ ...INFO, speedMps: null });
    render(<FrameTrainCard phone={false} />);
    expect(screen.queryByRole("region", { name: "Speed estimate" })).toBeNull();
  });

  it("is in the desktop detail card and follows the selection updates", () => {
    render(
      <TooltipProvider>
        <TrainPanel
          state={{ status: "ready", detail: testDetail() }}
          nowMs={NOW}
          handlers={{}}
          onClose={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText(`125${NO_BREAK_SPACE}km/h`)).toBeTruthy();
  });

  it("is in the expanded phone sheet and not in its peek", () => {
    const sheet = (defaultExpanded: boolean) => (
      <TooltipProvider>
        <TrainSheet
          state={{ status: "ready", detail: testDetail() }}
          nowMs={NOW}
          handlers={{}}
          onClose={vi.fn()}
          defaultExpanded={defaultExpanded}
        />
      </TooltipProvider>
    );
    const peek = render(sheet(false));
    expect(screen.queryByRole("region", { name: "Speed estimate" })).toBeNull();
    peek.unmount();
    render(sheet(true));
    expect(screen.getByRole("region", { name: "Speed estimate" })).toBeTruthy();
  });
});
