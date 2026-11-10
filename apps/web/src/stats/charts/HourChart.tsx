import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsHour } from "@gerlines/schema/stats";
import { numberFormat, percentTick } from "../format.ts";
import { durationText, hourSeries, percentOf } from "../model.ts";
import { ChartFrame, type Plot, type Tip } from "./frame.tsx";
import { columnPath, extremeLabelY } from "./geometry.ts";

const HEIGHT = 150;
const PLOT_TOP = 14;
const PLOT_HEIGHT = 104;
const PLOT_LEFT = 38;
const PLOT_RIGHT = 4;
const GAP = 2;
const TICK_EVERY = 3;

function plotOf(width: number): Plot {
  return {
    left: PLOT_LEFT,
    top: PLOT_TOP,
    width: Math.max(60, width - PLOT_LEFT - PLOT_RIGHT),
    height: PLOT_HEIGHT,
  };
}

export function hourName(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function HourChart({
  hours,
  average,
}: {
  hours: readonly StatsHour[];
  average: number | null;
}) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const series = hourSeries(hours);
  const shares = series.flatMap((entry) => (entry.punctual6 === null ? [] : [entry.punctual6]));
  const lowest = shares.length > 1 ? Math.min(...shares) : null;
  const highest = shares.length > 1 ? Math.max(...shares) : null;
  const tipAt = (index: number): Tip => {
    const entry = series[index];
    if (entry === undefined) return { title: "", rows: [] };
    const next = hourName(index).replace(":00", ":59");
    const share = percentOf(entry.punctual6, locale);
    return {
      title: copy.stats.period.range(hourName(index), next),
      rows: [
        { label: copy.stats.punctual.title, value: share ?? copy.delay.noData },
        {
          label: copy.stats.fact.observedArrivals,
          value: numberFormat(locale, 0).format(entry.observedArrivals),
        },
        {
          label: copy.stats.fact.mean,
          value: durationText(entry.meanDelayS, locale, copy.delay.minutes) ?? copy.delay.noData,
        },
      ],
    };
  };
  return (
    <div className="flex flex-col gap-2">
      <ChartFrame
        label={copy.stats.hour.title}
        hint={copy.stats.chartHint}
        count={24}
        plotOf={plotOf}
        anchorOf={(width, index) => {
          const plot = plotOf(width);
          return plot.left + ((index + 0.5) * plot.width) / 24;
        }}
        tipAt={tipAt}
      >
        {({ width, plot, cursor }) => {
          const band = plot.width / 24;
          const barWidth = Math.max(2, band - GAP);
          const yOf = (share: number) => plot.top + plot.height - share * plot.height;
          return (
            <svg
              width={width}
              height={HEIGHT}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              aria-hidden="true"
              className="block"
            >
              {[0, 0.5, 1].map((value) => (
                <g key={value}>
                  <line
                    x1={plot.left}
                    x2={plot.left + plot.width}
                    y1={yOf(value)}
                    y2={yOf(value)}
                    stroke="var(--gl-hairline)"
                    strokeWidth={1}
                  />
                  <text
                    x={plot.left - 6}
                    y={yOf(value) + 4}
                    textAnchor="end"
                    className="num"
                    fontSize={11}
                    fill="var(--gl-ink-muted)"
                  >
                    {percentTick(value, locale)}
                  </text>
                </g>
              ))}
              {series.map((entry, index) => {
                const x = plot.left + index * band + (band - barWidth) / 2;
                if (entry.punctual6 === null) {
                  return (
                    <line
                      key={entry.hour}
                      x1={x}
                      x2={x + barWidth}
                      y1={yOf(0) - 1}
                      y2={yOf(0) - 1}
                      stroke="var(--gl-passed)"
                      strokeWidth={2}
                      opacity={cursor === null || cursor === index ? 1 : 0.45}
                    />
                  );
                }
                const height = entry.punctual6 * plot.height;
                return (
                  <path
                    key={entry.hour}
                    d={columnPath(x, yOf(entry.punctual6), barWidth, height, 3)}
                    fill="var(--gl-ink)"
                    opacity={cursor === null ? 0.62 : cursor === index ? 1 : 0.3}
                  />
                );
              })}
              {average === null ? null : (
                <g>
                  <line
                    x1={plot.left}
                    x2={plot.left + plot.width}
                    y1={yOf(average)}
                    y2={yOf(average)}
                    stroke="var(--gl-surface)"
                    strokeWidth={3}
                  />
                  <line
                    x1={plot.left}
                    x2={plot.left + plot.width}
                    y1={yOf(average)}
                    y2={yOf(average)}
                    stroke="var(--gl-ink-muted)"
                    strokeWidth={1}
                  />
                </g>
              )}
              {[lowest, highest].map((value) => {
                if (value === null) return null;
                const index = series.findIndex((entry) => entry.punctual6 === value);
                const y = extremeLabelY(
                  series.map((entry) => entry.punctual6),
                  index,
                  average,
                  plot.top,
                  plot.height,
                );
                if (y === null) return null;
                return (
                  <text
                    key={value}
                    x={plot.left + (index + 0.5) * band}
                    y={y}
                    textAnchor="middle"
                    className="num"
                    fontSize={11}
                    fill="var(--gl-ink)"
                  >
                    {percentTick(value, locale)}
                  </text>
                );
              })}
              {series.map((entry, index) =>
                entry.hour % TICK_EVERY === 0 ? (
                  <text
                    key={`tick-${entry.hour}`}
                    x={plot.left + (index + 0.5) * band}
                    y={plot.top + plot.height + 16}
                    textAnchor="middle"
                    className="num"
                    fontSize={11}
                    fill="var(--gl-ink-muted)"
                  >
                    {String(entry.hour).padStart(2, "0")}
                  </text>
                ) : null,
              )}
            </svg>
          );
        }}
      </ChartFrame>
      {average === null ? null : (
        <p className="type-caption flex items-center gap-2 text-ink-muted">
          <span aria-hidden="true" className="h-px w-4 bg-ink-muted" />
          {copy.stats.hour.average(percentOf(average, locale) ?? "")}
        </p>
      )}
    </div>
  );
}
