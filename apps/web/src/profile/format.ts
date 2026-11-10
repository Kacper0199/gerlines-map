import type { ProfileCopy } from "@gerlines/i18n/profile";
import { STATS_SEGMENT_MIN_RUNS } from "@gerlines/schema/stats";
import { type Figures, legMeasure, type ProfileLeg, type Quantile } from "./model.ts";

export interface LegLine {
  readonly label: string;
  readonly value: string;
}

export interface LegDescription {
  readonly title: string;
  /** Both sides have figures, so the leg is coloured. */
  readonly known: boolean;
  readonly lines: readonly LegLine[];
}

const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string): Intl.NumberFormat {
  let format = formats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "negative" });
    formats.set(locale, format);
  }
  return format;
}

/** Seconds as minutes with at most one decimal, exactly the API's value, and the unit. */
export function minutesText(seconds: number, locale: string, unit: string): string {
  return `${numberFormat(locale).format(seconds / 60)} ${unit}`;
}

function figuresText(figures: Figures, copy: ProfileCopy, unit: string, locale: string): string {
  if (figures.status === "known") {
    const median = minutesText(figures.medianGainS, locale, unit);
    const p80 = minutesText(figures.p80GainS, locale, unit);
    return `${copy.tooltip.figures(median, p80)}, ${copy.runs(figures.runs)}`;
  }
  switch (figures.reason) {
    case "no_runs":
      return copy.reason.noRuns;
    case "too_few_runs":
      return copy.reason.tooFew(String(figures.runs), String(STATS_SEGMENT_MIN_RUNS));
    case "no_gains":
      return copy.reason.noGains(copy.runs(figures.runs));
    case "not_in_profile":
      return copy.reason.notInProfile;
  }
}

/** The words of a tooltip and a list row: the same figures the API sent, nothing recomputed but the difference. */
export function describeLeg(
  leg: ProfileLeg,
  quantile: Quantile,
  copy: ProfileCopy,
  unit: string,
  locale: string,
): LegDescription {
  const lines: LegLine[] = [
    { label: copy.tooltip.thisTrain, value: figuresText(leg.train, copy, unit, locale) },
    { label: copy.tooltip.allTrains, value: figuresText(leg.all, copy, unit, locale) },
  ];
  const measure = legMeasure(leg, quantile);
  if (measure.status === "known") {
    const seconds = Math.abs(measure.trainS - measure.allS);
    const value = minutesText(seconds, locale, unit);
    const difference =
      measure.trainS > measure.allS
        ? copy.tooltip.diffMore(value)
        : measure.trainS < measure.allS
          ? copy.tooltip.diffLess(value)
          : copy.tooltip.diffSame;
    lines.push({ label: copy.measure[quantile], value: difference });
  }
  return {
    title: copy.leg(leg.from, leg.to),
    known: measure.status === "known",
    lines,
  };
}
