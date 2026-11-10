import type { StatsDelayBin } from "@gerlines/schema/stats";
import { describe, expect, it } from "vitest";
import network from "../fixtures/network-2025-11.json" with { type: "json" };
import { bandIndex, TIP_WIDTH, tipLeft } from "./frame.tsx";
import {
  columnPath,
  delayDensities,
  delayLayout,
  delayTicks,
  extremeLabelY,
  niceMax,
  tickValues,
} from "./geometry.ts";

describe("niceMax", () => {
  it("rounds a maximum share up to a step that gives clean ticks", () => {
    expect(niceMax(0.148)).toBe(0.2);
    expect(niceMax(0.081)).toBe(0.1);
    expect(niceMax(0.32)).toBe(0.4);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(0)).toBe(0.1);
  });
});

describe("tickValues", () => {
  it("gives three ticks from zero to the maximum", () => {
    expect(tickValues(0.2)).toEqual([0, 0.1, 0.2]);
  });
});

describe("columnPath", () => {
  it("rounds only the data end and starts on the baseline", () => {
    const path = columnPath(10, 20, 8, 30, 3);
    expect(path.startsWith("M10 50")).toBe(true);
    expect(path).toContain("A3 3");
  });
  it("keeps a very short bar square so the radius never exceeds the bar", () => {
    expect(columnPath(0, 0, 8, 2, 3)).not.toContain("A");
  });
});

describe("bandIndex", () => {
  it("maps a pointer offset to the mark band it falls in and clamps the ends", () => {
    expect(bandIndex(0, 240, 24)).toBe(0);
    expect(bandIndex(25, 240, 24)).toBe(2);
    expect(bandIndex(239, 240, 24)).toBe(23);
    expect(bandIndex(-30, 240, 24)).toBe(0);
    expect(bandIndex(400, 240, 24)).toBe(23);
  });
});

const BINS = network.delayHistogram as StatsDelayBin[];

describe("delayDensities", () => {
  it("divides every closed bin by its width in minutes, so wide bins do not tower", () => {
    const density = delayDensities(BINS);
    const at = (fromS: number) =>
      density[BINS.findIndex((bin) => bin.fromS === fromS)] ?? Number.NaN;
    expect(at(900)).toBe(2905);
    expect(at(960)).toBe(9385 / 4);
    expect(at(3600)).toBe(4478 / 30);
    expect(at(-1800)).toBe(1615 / 25);
  });

  it("falls monotonically after the peak, with no bump where the bins widen", () => {
    const density = delayDensities(BINS);
    const peak = density.indexOf(Math.max(...density));
    expect(BINS[peak]?.fromS).toBe(0);
    const after = density.slice(peak);
    for (let index = 1; index < after.length; index++) {
      expect(after[index] ?? 0).toBeLessThanOrEqual(after[index - 1] ?? 0);
    }
  });

  it("gives the open bin the width of the bin before it", () => {
    const density = delayDensities(BINS);
    expect(density.at(-1)).toBe(780 / 30);
  });

  it("counts zero for an empty histogram", () => {
    expect(delayDensities([])).toEqual([]);
  });
});

describe("delayLayout", () => {
  const layout = delayLayout(BINS, 286);

  it("fills the plot width from the first bin to the last", () => {
    expect(layout.bins).toHaveLength(BINS.length);
    expect(layout.bins[0]?.x).toBe(0);
    const last = layout.bins.at(-1);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(286, 6);
  });

  it("draws bins in order, side by side, with the break as the only gap", () => {
    const breakAt = BINS.findIndex((bin) => bin.fromS === 960);
    const squeezeEnd = BINS.findIndex((bin) => bin.fromS === -300);
    layout.bins.forEach((bin, index) => {
      const before = layout.bins[index - 1];
      if (before === undefined) return;
      const gap = bin.x - (before.x + before.width);
      if (index === breakAt || index === squeezeEnd) expect(gap).toBeGreaterThan(2);
      else expect(gap).toBeCloseTo(0, 6);
    });
    const before = layout.bins[breakAt - 1];
    expect(layout.breaks.at(-1)).toBeGreaterThan((before?.x ?? 0) + (before?.width ?? 0));
    expect(layout.breaks.at(-1)).toBeLessThan(layout.bins[breakAt]?.x ?? 0);
  });

  it("marks the squeezed early bin with a break of its own, between it and minus 5", () => {
    expect(layout.breaks).toHaveLength(2);
    const early = layout.bins[0];
    const next = layout.bins[1];
    expect(layout.breaks[0]).toBeGreaterThan((early?.x ?? 0) + (early?.width ?? 0));
    expect(layout.breaks[0]).toBeLessThan(next?.x ?? 0);
    expect(layout.edgeX(-5)).toBe(next?.x);
  });

  it("gives the squeezed bin enough room for its label next to the minus 5 label", () => {
    expect(layout.bins[0]?.width).toBeGreaterThan(20);
  });

  it("gives equal-length bins equal widths before the break and after it", () => {
    const widthOf = (fromS: number) =>
      layout.bins[BINS.findIndex((bin) => bin.fromS === fromS)]?.width ?? Number.NaN;
    expect(widthOf(60)).toBeCloseTo(widthOf(600), 6);
    expect(widthOf(1200)).toBeCloseTo(widthOf(1500), 6);
    expect(widthOf(5400)).toBeCloseTo(widthOf(3600), 6);
  });

  it("scales widths with the minutes a bin spans, within each side of the break", () => {
    const widthOf = (fromS: number) =>
      layout.bins[BINS.findIndex((bin) => bin.fromS === fromS)]?.width ?? Number.NaN;
    expect(widthOf(3600) / widthOf(1200)).toBeCloseTo(30 / 5, 6);
    expect(widthOf(960) / widthOf(1200)).toBeCloseTo(4 / 5, 6);
    expect(widthOf(300) / widthOf(0)).toBeCloseTo(1, 6);
  });

  it("keeps every drawn bar inside its band and at least a pixel wide", () => {
    for (const bin of layout.bins) {
      expect(bin.barWidth).toBeGreaterThanOrEqual(1);
      expect(bin.barX).toBeGreaterThanOrEqual(bin.x);
      expect(bin.barX + bin.barWidth).toBeLessThanOrEqual(bin.x + bin.width + 1e-9);
    }
  });

  it("puts the edge ticks on the left edge of the bin that starts there", () => {
    const edge = (minutes: number) => layout.edgeX(minutes);
    expect(edge(0)).toBe(layout.bins[BINS.findIndex((bin) => bin.fromS === 0)]?.x);
    expect(edge(16)).toBe(layout.bins[BINS.findIndex((bin) => bin.fromS === 960)]?.x);
    expect(edge(120)).toBe(layout.bins.at(-1)?.x);
    expect(edge(17)).toBeNull();
  });

  it("finds the bin under a pointer, taking the gap for its right neighbour", () => {
    expect(layout.binAt(-5)).toBe(0);
    expect(layout.binAt(0.1)).toBe(0);
    expect(layout.binAt(1000)).toBe(BINS.length - 1);
    const third = layout.bins[3];
    expect(layout.binAt((third?.x ?? 0) + (third?.width ?? 0) / 2)).toBe(3);
    const breakAt = BINS.findIndex((bin) => bin.fromS === 960);
    const first = layout.bins[breakAt];
    expect(layout.binAt((first?.x ?? 0) - 0.5)).toBe(breakAt);
  });

  it("lays out a histogram without a break, and an empty one", () => {
    const short = delayLayout(BINS.slice(2, 10), 200);
    expect(short.breaks).toEqual([]);
    expect(delayLayout([], 200).bins).toEqual([]);
  });

  it("treats a bin with no lower edge as an early bin of fixed width", () => {
    const open = delayLayout([{ fromS: null, toS: 0, count: 3 }, ...BINS.slice(2, 4)], 100);
    expect(open.bins[0]?.width).toBeGreaterThan(0);
    expect(
      delayDensities([
        { fromS: null, toS: 0, count: 6 },
        { fromS: 0, toS: 60, count: 6 },
      ]),
    ).toEqual([6 / 1, 6]);
  });
});

describe("delayTicks", () => {
  const labelOf = (bin: StatsDelayBin) =>
    bin.fromS === null ? "" : `${Math.round(bin.fromS / 60)}${bin.toS === null ? "+" : ""}`;
  const ticksAt = (width: number, bins: readonly StatsDelayBin[] = BINS) =>
    delayTicks(bins, delayLayout(bins, width), width, labelOf);

  it("labels the first edge, minus 5, a few minutes before the break, the break and the tail", () => {
    expect(ticksAt(286).map((tick) => tick.minutes)).toEqual([-30, -5, 0, 5, 10, 16, 60, 120]);
  });

  it("brings 30 back when the plot is wide enough for it to stand clear of 16", () => {
    expect(ticksAt(640).map((tick) => tick.minutes)).toContain(30);
    expect(ticksAt(286).map((tick) => tick.minutes)).not.toContain(30);
  });

  it("never lets two labels touch, at any plot width", () => {
    for (const width of [180, 220, 260, 286, 320, 400, 520, 640]) {
      const boxes = ticksAt(width).map((tick) => {
        const size = tick.label.length * 6.6;
        const from =
          tick.anchor === "start"
            ? tick.labelX
            : tick.anchor === "end"
              ? tick.labelX - size
              : tick.labelX - size / 2;
        return { from, to: from + size };
      });
      boxes.forEach((box, index) => {
        const before = boxes[index - 1];
        if (before !== undefined)
          expect(box.from - before.to, `width ${width}`).toBeGreaterThanOrEqual(4);
      });
    }
  });

  it("starts the first label at the plot edge and ends the last one at the other", () => {
    const ticks = ticksAt(286);
    expect(ticks[0]).toMatchObject({ anchor: "start", labelX: 0, edge: 0 });
    expect(ticks.at(-1)).toMatchObject({ anchor: "end", labelX: 286, label: "120+" });
  });

  it("leaves out an edge no bin starts at", () => {
    expect(ticksAt(200, BINS.slice(2, 8)).map((tick) => tick.minutes)).toEqual([0, 5]);
  });
});

describe("tipLeft", () => {
  it("puts the tooltip right of a mark in the left half and left of it in the right half", () => {
    expect(tipLeft(60, 320)).toBe(68);
    expect(tipLeft(260, 320)).toBe(260 - 8 - TIP_WIDTH);
  });
  it("keeps the whole tooltip inside the chart near either edge", () => {
    expect(tipLeft(150, 320)).toBe(320 - TIP_WIDTH);
    expect(tipLeft(170, 320)).toBeGreaterThanOrEqual(0);
    expect(tipLeft(150, 260)).toBeLessThanOrEqual(260 - TIP_WIDTH);
    expect(tipLeft(310, 320)).toBeGreaterThanOrEqual(0);
    expect(tipLeft(5, 320) + TIP_WIDTH).toBeLessThanOrEqual(320);
  });
  it("is wide enough for a title and a row on one line each", () => {
    expect(TIP_WIDTH).toBeGreaterThanOrEqual(176);
  });
});

describe("extremeLabelY", () => {
  const top = 14;
  const height = 100;
  const yOf = (share: number) => top + height - share * height;

  it("sits just above the bar when no neighbour or line is in the way", () => {
    const shares = [0.4, 0.9, 0.5];
    expect(extremeLabelY(shares, 1, null, top, height)).toBe(yOf(0.9) - 4);
  });

  it("rises above a taller neighbour so the number does not run into its bar", () => {
    const shares = [0.8, 0.3, 0.5];
    expect(extremeLabelY(shares, 1, null, top, height)).toBe(yOf(0.8) - 4);
  });

  it("skips missing hours when it looks at the neighbours", () => {
    expect(extremeLabelY([null, 0.3, null], 1, null, top, height)).toBe(yOf(0.3) - 4);
    expect(extremeLabelY([0.3], 0, null, top, height)).toBe(yOf(0.3) - 4);
  });

  it("is dropped when the label would sit on the average line", () => {
    const shares = [0.55, 0.5, 0.52];
    expect(extremeLabelY(shares, 1, 0.58, top, height)).toBeNull();
    expect(extremeLabelY(shares, 1, 0.2, top, height)).not.toBeNull();
  });
});
