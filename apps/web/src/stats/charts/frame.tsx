import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export const DEFAULT_WIDTH = 320;
export const TIP_WIDTH = 208;
const TIP_GAP = 8;

/** The left edge of the tooltip beside a mark at `x`, flipped in the right half and held inside the chart. */
export function tipLeft(x: number, width: number): number {
  const wanted = x > width / 2 ? x - TIP_GAP - TIP_WIDTH : x + TIP_GAP;
  return Math.max(0, Math.min(wanted, width - TIP_WIDTH));
}

export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = Math.floor(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface TipRow {
  readonly label: string;
  readonly value: string;
}

export interface Tip {
  readonly title: string;
  readonly rows: readonly TipRow[];
}

export interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameState {
  readonly width: number;
  readonly plot: Plot;
  readonly cursor: number | null;
}

export function tipText(tip: Tip): string {
  return `${tip.title}. ${tip.rows.map((row) => `${row.label} ${row.value}`).join(". ")}`;
}

export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}

/** The mark under a pointer: marks share the plot width in equal bands. */
export function bandIndex(offset: number, plotWidth: number, count: number): number {
  return clampIndex(Math.floor((offset / plotWidth) * count), count);
}

function keyboardTarget(key: string, current: number | null, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return clampIndex((current ?? -1) + 1, count);
  if (key === "ArrowLeft") return clampIndex((current ?? count) - 1, count);
  return null;
}

/**
 * The hover and keyboard layer shared by the charts: the pointer finds the mark by its x
 * position, arrow keys move between marks, and the same readout shows in a tooltip and in a
 * live region, so no value depends on hovering.
 */
export function ChartFrame({
  label,
  hint,
  count,
  plotOf,
  anchorOf,
  indexAt,
  tipAt,
  children,
}: {
  label: string;
  hint: string;
  count: number;
  plotOf: (width: number) => Plot;
  /** The x centre of mark `index` in chart pixels. */
  anchorOf: (width: number, index: number) => number;
  /** The mark under a pointer offset in plot pixels; marks of equal width when left out. */
  indexAt?: (offset: number, plot: Plot) => number;
  tipAt: (index: number) => Tip;
  children: (state: FrameState) => ReactNode;
}) {
  const hintId = useId();
  const holder = useRef<HTMLDivElement>(null);
  const width = useWidth(holder);
  const plot = plotOf(width);
  const [cursor, setCursor] = useState<number | null>(null);
  const [byKeyboard, setByKeyboard] = useState(false);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = holder.current?.getBoundingClientRect();
    if (box === undefined || count === 0) return;
    setByKeyboard(false);
    const offset = event.clientX - box.left - plot.left;
    setCursor(
      indexAt === undefined
        ? bandIndex(offset, plot.width, count)
        : clampIndex(indexAt(offset, plot), count),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = keyboardTarget(event.key, cursor, count);
    if (target === null) return;
    event.preventDefault();
    setByKeyboard(true);
    setCursor(target);
  };
  const tip = cursor === null ? null : tipAt(cursor);
  const x = cursor === null ? 0 : anchorOf(width, cursor);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot take the arrow-key readout of the marks
    <div
      ref={holder}
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is the one stop for the arrow keys that read each mark
      tabIndex={0}
      aria-label={label}
      aria-describedby={hintId}
      data-slot="chart"
      className="focus-ring relative rounded-md"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setCursor(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setCursor(null)}
    >
      <span id={hintId} className="sr-only">
        {hint}
      </span>
      {children({ width, plot, cursor })}
      {tip !== null ? (
        <div
          data-slot="chart-tip"
          className="card-surface pointer-events-none absolute z-10 flex flex-col gap-0.5 px-2.5 py-1.5"
          style={{ left: tipLeft(x, width), top: Math.max(0, plot.top - 4), width: TIP_WIDTH }}
        >
          <span className="type-label">{tip.title}</span>
          {tip.rows.map((row) => (
            <span key={row.label} className="type-caption flex justify-between gap-3">
              <span className="text-ink-muted">{row.label}</span>
              <span className="num text-ink">{row.value}</span>
            </span>
          ))}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {byKeyboard && tip !== null ? tipText(tip) : ""}
      </span>
    </div>
  );
}
