import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsDelayBin } from "@gerlines/schema/stats";
import { numberFormat, percentTick } from "../format.ts";
import {
  binClass,
  binLabelMinutes,
  DELAY_CLASSES,
  type DelayClass,
  delayClasses,
  percentOf,
  signedMinutes,
} from "../model.ts";
import { Percent } from "../NumberText.tsx";
import { ChartFrame, type Plot, type Tip } from "./frame.tsx";
import {
  columnPath,
  delayDensities,
  delayLayout,
  delayTicks,
  isOpenBin,
  niceMax,
  tickValues,
} from "./geometry.ts";

const HEIGHT = 166;
const PLOT_TOP = 8;
const PLOT_HEIGHT = 124;
const PLOT_LEFT = 38;
const PLOT_RIGHT = 4;
const OPEN_OPACITY = 0.55;

export function binTitle(bin: StatsDelayBin, copy: ReturnType<typeof useStatsCopy>): string {
  const minutes = (seconds: number) => signedMinutes(Math.round(seconds / 60));
  if (bin.fromS === null) {
    return bin.toS === null ? "" : copy.stats.delay.binBelow(minutes(bin.toS));
  }
  return bin.toS === null
    ? copy.stats.delay.binOpen(minutes(bin.fromS))
    : copy.stats.delay.binRange(minutes(bin.fromS), minutes(bin.toS));
}

function plotOf(width: number): Plot {
  return {
    left: PLOT_LEFT,
    top: PLOT_TOP,
    width: Math.max(60, width - PLOT_LEFT - PLOT_RIGHT),
    height: PLOT_HEIGHT,
  };
}

export function DelayChart({ histogram }: { histogram: readonly StatsDelayBin[] }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const total = histogram.reduce((sum, bin) => sum + bin.count, 0);
  const shareOf = (count: number) => (total === 0 ? 0 : count / total);
  const perMinute = delayDensities(histogram).map(shareOf);
  const top = niceMax(Math.max(0, ...perMinute));
  const layoutAt = (plotWidth: number) => delayLayout(histogram, plotWidth);
  const tipAt = (index: number): Tip => {
    const bin = histogram[index];
    if (bin === undefined) return { title: "", rows: [] };
    const rows = [
      { label: copy.stats.fact.observed, value: numberFormat(locale, 0).format(bin.count) },
      {
        label: copy.stats.delay.share,
        value: percentOf(shareOf(bin.count), locale, copy.stats.under) ?? "",
      },
    ];
    if (!isOpenBin(bin)) {
      rows.push({
        label: copy.stats.delay.perMinute,
        value: percentOf(perMinute[index] ?? 0, locale, copy.stats.under) ?? "",
      });
    }
    return { title: binTitle(bin, copy), rows };
  };
  return (
    <div className="flex flex-col gap-3">
      <ChartFrame
        label={copy.stats.delay.title}
        hint={copy.stats.chartHint}
        count={histogram.length}
        plotOf={plotOf}
        anchorOf={(width, index) => {
          const plot = plotOf(width);
          const box = layoutAt(plot.width).bins[index];
          return plot.left + (box?.x ?? 0) + (box?.width ?? 0) / 2;
        }}
        indexAt={(offset, plot) => layoutAt(plot.width).binAt(offset)}
        tipAt={tipAt}
      >
        {({ width, plot, cursor }) => {
          const layout = layoutAt(plot.width);
          const baseline = plot.top + plot.height;
          return (
            <svg
              width={width}
              height={HEIGHT}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              aria-hidden="true"
              className="block"
            >
              {tickValues(top).map((value) => {
                const y = baseline - (value / top) * plot.height;
                return (
                  <g key={value}>
                    <line
                      x1={plot.left}
                      x2={plot.left + plot.width}
                      y1={y}
                      y2={y}
                      stroke="var(--gl-hairline)"
                      strokeWidth={1}
                    />
                    <text
                      x={plot.left - 6}
                      y={y + 4}
                      textAnchor="end"
                      className="num"
                      fontSize={11}
                      fill="var(--gl-ink-muted)"
                    >
                      {percentTick(value, locale)}
                    </text>
                  </g>
                );
              })}
              {histogram.map((bin, index) => {
                const box = layout.bins[index];
                if (box === undefined) return null;
                const height = ((perMinute[index] ?? 0) / top) * plot.height;
                const focused = cursor === null || cursor === index;
                return (
                  <path
                    key={bin.fromS ?? "open-start"}
                    data-bin={index}
                    data-height={height.toFixed(2)}
                    d={columnPath(plot.left + box.barX, baseline - height, box.barWidth, height, 3)}
                    fill={`var(--gl-delay-${binClass(bin)})`}
                    opacity={(isOpenBin(bin) ? OPEN_OPACITY : 1) * (focused ? 1 : 0.45)}
                  />
                );
              })}
              {layout.breaks.map((breakX) => (
                <path
                  key={breakX}
                  data-slot="axis-break"
                  d={`M${plot.left + breakX - 3} ${baseline + 4}l3 -8M${plot.left + breakX + 1} ${baseline + 4}l3 -8`}
                  stroke="var(--gl-ink-muted)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  fill="none"
                />
              ))}
              {delayTicks(histogram, layout, plot.width, binLabelMinutes).map((tick) => (
                <g key={`tick-${tick.minutes}`}>
                  <line
                    x1={plot.left + tick.edge}
                    x2={plot.left + tick.edge}
                    y1={baseline}
                    y2={baseline + 4}
                    stroke="var(--gl-ink-muted)"
                    strokeWidth={1}
                  />
                  <text
                    x={plot.left + tick.labelX}
                    y={baseline + 16}
                    textAnchor={tick.anchor}
                    className="num"
                    fontSize={11}
                    fill="var(--gl-ink-muted)"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}
            </svg>
          );
        }}
      </ChartFrame>
      <p className="type-caption text-ink-muted">{copy.stats.delay.axis}</p>
      <DelayLegend histogram={histogram} />
    </div>
  );
}

function DelayLegend({ histogram }: { histogram: readonly StatsDelayBin[] }) {
  const copy = useStatsCopy();
  const classes = delayClasses(histogram);
  const names: Record<DelayClass, string> = copy.legend.delay;
  return (
    <ul className="flex flex-col gap-1" aria-label={copy.stats.delay.share}>
      {DELAY_CLASSES.map((name) => (
        <li key={name} className="type-body flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: `var(--gl-delay-${name})` }}
          />
          <span className="min-w-0 flex-1 text-ink-muted">{names[name]}</span>
          <span className="num text-ink">
            {classes.total === 0 ? null : <Percent share={classes[name] / classes.total} />}
          </span>
        </li>
      ))}
    </ul>
  );
}
