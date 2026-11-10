import type { StatsDelayBin } from "@gerlines/schema/stats";

const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1];

/** A maximum share rounded up so that half of it is also a clean tick. */
export function niceMax(max: number): number {
  if (max <= 0) return 0.1;
  const step = STEPS.find((candidate) => max <= candidate * 2) ?? 1;
  return Math.min(1, Math.ceil(max / step - 1e-9) * step);
}

export function tickValues(max: number): number[] {
  return [0, max / 2, max];
}

/** A column from the baseline up, with the radius only on the data end (top). */
export function columnPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const base = y + height;
  const r = Math.min(radius, width / 2, height);
  if (height <= radius * 1.5 || r <= 0) {
    return `M${x} ${base}V${y}H${x + width}V${base}Z`;
  }
  return `M${x} ${base}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${base}Z`;
}

const SECONDS_PER_MINUTE = 60;
const EARLY_BEFORE_MIN = -5;
const BREAK_AT_MIN = 16;
const EARLY_UNITS_PER_MIN = 0.24;
const FINE_UNITS_PER_MIN = 1;
const COARSE_UNITS_PER_MIN = 0.25;
const OPEN_UNITS = 3;
const BREAK_UNITS = 1.5;
const WIDE_BAND_PX = 8;
const LABEL_CHAR_PX = 6.6;
const LABEL_GAP_PX = 6;
const TICK_PRIORITY = [0, BREAK_AT_MIN, 120, EARLY_BEFORE_MIN, -30, 60, 10, 5, 30] as const;

type Edges = Pick<StatsDelayBin, "fromS" | "toS">;

function isOpen(bin: Edges): boolean {
  return bin.fromS === null || bin.toS === null;
}

function isEarly(bin: Edges): boolean {
  return bin.fromS !== null && bin.fromS / SECONDS_PER_MINUTE < EARLY_BEFORE_MIN;
}

function isTail(bin: Edges): boolean {
  return bin.fromS !== null && bin.fromS / SECONDS_PER_MINUTE >= BREAK_AT_MIN;
}

function closedMinutes(bin: Edges): number | null {
  if (bin.fromS === null || bin.toS === null) return null;
  return (bin.toS - bin.fromS) / SECONDS_PER_MINUTE;
}

/** Minutes a bin spans; an open bin takes the width of its closed neighbour, one minute if it has none. */
function spanMinutes(bins: readonly Edges[], index: number): number {
  const bin = bins[index];
  if (bin === undefined) return 1;
  const own = closedMinutes(bin);
  if (own !== null) return own;
  const neighbour = bins[bin.fromS === null ? index + 1 : index - 1];
  return (neighbour === undefined ? null : closedMinutes(neighbour)) ?? 1;
}

/**
 * The height of each bar as a count per minute of delay. Bins widen after 16 minutes, so a count
 * alone would put a peak where the data has none; per minute, the area of a bar is its count.
 */
export function delayDensities(bins: readonly (Edges & { readonly count: number })[]): number[] {
  return bins.map((bin, index) => bin.count / spanMinutes(bins, index));
}

function unitsOf(bin: Edges): number {
  const minutes = closedMinutes(bin);
  if (minutes === null || bin.fromS === null) return OPEN_UNITS;
  const from = bin.fromS / SECONDS_PER_MINUTE;
  if (from < EARLY_BEFORE_MIN) return minutes * EARLY_UNITS_PER_MIN;
  return minutes * (from < BREAK_AT_MIN ? FINE_UNITS_PER_MIN : COARSE_UNITS_PER_MIN);
}

export interface DelayBinBox {
  /** The band the bin owns, including its share of the gap between bars. */
  readonly x: number;
  readonly width: number;
  readonly barX: number;
  readonly barWidth: number;
}

export interface DelayLayout {
  readonly bins: readonly DelayBinBox[];
  /** The middle of each gap where the scale changes: after the early bins and at 16 minutes. */
  readonly breaks: readonly number[];
  readonly width: number;
  /** The left edge of the bin that starts at `minutes`, null when none does. */
  edgeX(minutes: number): number | null;
  /** The bin under a pointer offset in plot pixels; the break counts for the bin after it. */
  binAt(offset: number): number;
}

/**
 * Bins side by side on a minutes scale: one minute of delay is a unit wide from minus 5 to 16
 * minutes, later minutes are a quarter of that, and bins before minus 5 are squeezed so the tail
 * of early stops does not take a third of the plot. Each change of scale is a marked break.
 */
export function delayLayout(bins: readonly Edges[], plotWidth: number): DelayLayout {
  const breakIndexes = new Set(
    bins.flatMap((bin, index) => {
      const before = bins[index - 1];
      if (before === undefined) return [];
      return (isTail(bin) && !isTail(before)) || (!isEarly(bin) && isEarly(before)) ? [index] : [];
    }),
  );
  const units = bins.map(unitsOf);
  const total = units.reduce((sum, value) => sum + value, 0) + breakIndexes.size * BREAK_UNITS;
  const pixels = total === 0 ? 0 : plotWidth / total;
  let cursor = 0;
  const breaks: number[] = [];
  const boxes = bins.map((_, index): DelayBinBox => {
    if (breakIndexes.has(index)) {
      breaks.push((cursor + BREAK_UNITS / 2) * pixels);
      cursor += BREAK_UNITS;
    }
    const x = cursor * pixels;
    const width = (units[index] ?? 0) * pixels;
    cursor += units[index] ?? 0;
    const gap = width >= WIDE_BAND_PX ? 2 : 1;
    const barWidth = Math.min(width, Math.max(1, width - gap));
    return { x, width, barX: x + (width - barWidth) / 2, barWidth };
  });
  return {
    bins: boxes,
    breaks,
    width: plotWidth,
    edgeX(minutes) {
      const index = bins.findIndex((bin) => bin.fromS === minutes * SECONDS_PER_MINUTE);
      return index < 0 ? null : (boxes[index]?.x ?? null);
    },
    binAt(offset) {
      const index = boxes.findIndex((box) => offset < box.x + box.width);
      return index < 0 ? Math.max(0, boxes.length - 1) : index;
    },
  };
}

export interface DelayTick {
  readonly minutes: number;
  /** Where the tick line stands: the left edge of the bin that starts at `minutes`. */
  readonly edge: number;
  readonly labelX: number;
  readonly anchor: "start" | "middle" | "end";
  readonly label: string;
}

/**
 * The edges that get a label, most useful first: zero, the break, the tail, minus 5, the first
 * edge, then the rest. A label that would touch one already placed is left out, so the set
 * follows the plot width.
 */
export function delayTicks<Bin extends Edges>(
  bins: readonly Bin[],
  layout: DelayLayout,
  plotWidth: number,
  labelOf: (bin: Bin) => string,
): DelayTick[] {
  const placed: PlacedTick[] = [];
  for (const minutes of TICK_PRIORITY) {
    const bin = bins.find((entry) => entry.fromS === minutes * SECONDS_PER_MINUTE);
    const edge = layout.edgeX(minutes);
    if (bin === undefined || edge === null) continue;
    const candidate = placeTick(minutes, edge, bin.toS === null, plotWidth, labelOf(bin));
    if (!placed.some((other) => touches(candidate, other))) placed.push(candidate);
  }
  return placed.map((entry) => entry.tick).sort((a, b) => a.edge - b.edge);
}

interface PlacedTick {
  readonly tick: DelayTick;
  readonly from: number;
  readonly to: number;
}

function placeTick(
  minutes: number,
  edge: number,
  last: boolean,
  plotWidth: number,
  label: string,
): PlacedTick {
  const anchor = last ? "end" : edge === 0 ? "start" : "middle";
  const labelX = last ? plotWidth : edge;
  const size = label.length * LABEL_CHAR_PX;
  const from = anchor === "start" ? labelX : anchor === "end" ? labelX - size : labelX - size / 2;
  return { tick: { minutes, edge, labelX, anchor, label }, from, to: from + size };
}

function touches(a: PlacedTick, b: PlacedTick): boolean {
  return a.from < b.to + LABEL_GAP_PX && a.to + LABEL_GAP_PX > b.from;
}

export { isOpen as isOpenBin };

const LABEL_HEIGHT = 11;
const LABEL_LIFT = 4;
const LINE_CLEARANCE = 3;

/**
 * Where the number of an extreme hour goes: above the tallest bar within one hour of it, so it
 * never prints over a neighbour. Null when the average line crosses that spot; the readout
 * still gives the value.
 */
export function extremeLabelY(
  shares: readonly (number | null)[],
  index: number,
  average: number | null,
  plotTop: number,
  plotHeight: number,
): number | null {
  const near = [shares[index - 1], shares[index], shares[index + 1]].flatMap((value) =>
    value === null || value === undefined ? [] : [value],
  );
  if (near.length === 0) return null;
  const yOf = (share: number) => plotTop + plotHeight - share * plotHeight;
  const y = yOf(Math.max(...near)) - LABEL_LIFT;
  if (average !== null) {
    const line = yOf(average);
    if (line > y - LABEL_HEIGHT - LINE_CLEARANCE && line < y + LINE_CLEARANCE) return null;
  }
  return y;
}
