import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsDay } from "@gerlines/schema/stats";
import { formatDay, numberFormat, percentTick } from "../format.ts";
import { durationText, percentOf } from "../model.ts";
import { ChartFrame, type Plot, type Tip } from "./frame.tsx";

const HEIGHT = 150;
const PLOT_TOP = 10;
const PLOT_HEIGHT = 104;
const PLOT_LEFT = 38;
const PLOT_RIGHT = 10;

function plotOf(width: number): Plot {
  return {
    left: PLOT_LEFT,
    top: PLOT_TOP,
    width: Math.max(60, width - PLOT_LEFT - PLOT_RIGHT),
    height: PLOT_HEIGHT,
  };
}

export function linePaths(
  values: readonly (number | null)[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
): string[] {
  const paths: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (value === null) {
      if (current !== "") paths.push(current);
      current = "";
      return;
    }
    current += `${current === "" ? "M" : "L"}${xOf(index).toFixed(1)} ${yOf(value).toFixed(1)}`;
  });
  if (current !== "") paths.push(current);
  return paths;
}

export function DayChart({ days }: { days: readonly (StatsDay & { runs?: number })[] }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const tipAt = (index: number): Tip => {
    const entry = days[index];
    if (entry === undefined) return { title: "", rows: [] };
    return {
      title: formatDay(entry.day, locale),
      rows: [
        {
          label: copy.stats.punctual.title,
          value: percentOf(entry.punctual6, locale) ?? copy.delay.noData,
        },
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
  const count = days.length;
  return (
    <ChartFrame
      label={copy.stats.day.title}
      hint={copy.stats.chartHint}
      count={count}
      plotOf={plotOf}
      anchorOf={(width, index) => {
        const plot = plotOf(width);
        return plot.left + ((index + 0.5) * plot.width) / count;
      }}
      tipAt={tipAt}
    >
      {({ width, plot, cursor }) => {
        const band = plot.width / count;
        const xOf = (index: number) => plot.left + (index + 0.5) * band;
        const yOf = (share: number) => plot.top + plot.height - share * plot.height;
        const values = days.map((entry) => entry.punctual6);
        const last = values.findLastIndex((value) => value !== null);
        const lastValue = last >= 0 ? values[last] : null;
        const ticks = [0, Math.floor((count - 1) / 2), count - 1].filter(
          (index, position, all) => all.indexOf(index) === position,
        );
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
            {linePaths(values, xOf, yOf).map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                stroke="var(--gl-ink)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {cursor !== null ? (
              <line
                x1={xOf(cursor)}
                x2={xOf(cursor)}
                y1={plot.top}
                y2={plot.top + plot.height}
                stroke="var(--gl-passed)"
                strokeWidth={1}
              />
            ) : null}
            {values.map((value, index) =>
              value !== null && (index === last || index === cursor) ? (
                <circle
                  key={days[index]?.day}
                  cx={xOf(index)}
                  cy={yOf(value)}
                  r={4}
                  fill="var(--gl-ink)"
                  stroke="var(--gl-surface)"
                  strokeWidth={2}
                />
              ) : null,
            )}
            {lastValue !== null && lastValue !== undefined ? (
              <text
                x={xOf(last)}
                y={yOf(lastValue) - 10}
                textAnchor="end"
                className="num"
                fontSize={11}
                fill="var(--gl-ink)"
              >
                {percentOf(lastValue, locale)}
              </text>
            ) : null}
            {ticks.map((index, position) => (
              <text
                key={days[index]?.day}
                x={xOf(index)}
                y={plot.top + plot.height + 16}
                textAnchor={
                  position === 0 ? "start" : position === ticks.length - 1 ? "end" : "middle"
                }
                className="num"
                fontSize={11}
                fill="var(--gl-ink-muted)"
              >
                {days[index] ? formatDay(days[index].day, locale, "short") : ""}
              </text>
            ))}
          </svg>
        );
      }}
    </ChartFrame>
  );
}
