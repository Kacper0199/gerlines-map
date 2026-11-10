import { type Copy, copyFor } from "./copy.ts";
import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

/** The segment profile strings of the train card (WP-7.4b), loaded with the lazy card and not with the entry. */
export function createProfileCopy(locale: Locale) {
  const o = { locale };
  return {
    title: m.profile_title({}, o),
    open: m.profile_open({}, o),
    close: m.profile_close({}, o),
    loading: m.profile_loading({}, o),
    error: m.profile_error({}, o),
    retry: m.profile_retry({}, o),
    retryIn: (seconds: number) => m.profile_retry_in({ seconds }, o),
    empty: m.profile_empty({}, o),
    notPlaced: m.profile_not_placed({}, o),
    leg: (from: string, to: string) => m.profile_leg({ from, to }, o),
    period: (from: string, to: string) => m.profile_period({ from, to }, o),
    measure: {
      label: m.profile_measure_label({}, o),
      median: m.profile_measure_median({}, o),
      p80: m.profile_measure_p80({}, o),
    },
    legend: {
      title: m.profile_legend_title({}, o),
      low: m.profile_legend_low({}, o),
      high: m.profile_legend_high({}, o),
      zero: m.profile_legend_zero({}, o),
      missing: m.profile_legend_missing({}, o),
    },
    curtain: (cap: string) => m.profile_curtain({ cap }, o),
    listShow: (count: number) => m.profile_list_show({ count }, o),
    listHide: m.profile_list_hide({}, o),
    tooltip: {
      thisTrain: m.profile_tooltip_this({}, o),
      allTrains: m.profile_tooltip_all({}, o),
      figures: (median: string, p80: string) => m.profile_figures({ median, p80 }, o),
      diffMore: (value: string) => m.profile_diff_more({ value }, o),
      diffLess: (value: string) => m.profile_diff_less({ value }, o),
      diffSame: m.profile_diff_same({}, o),
    },
    runs: (count: number) => m.profile_runs({ count }, o),
    reason: {
      noRuns: m.profile_reason_no_runs({}, o),
      tooFew: (runs: string, min: string) => m.profile_reason_too_few({ runs, min }, o),
      noGains: (runs: string) => m.profile_reason_no_gains({ runs }, o),
      notInProfile: m.profile_reason_not_in_profile({}, o),
    },
    group: (category: string, operator: string, runs: string) =>
      m.profile_group({ category, operator, runs }, o),
    others: (count: number) => m.profile_others({ count }, o),
    note: m.profile_note({}, o),
    idsDiffer: (count: number) => m.profile_ids_differ({ count }, o),
  };
}

export type ProfileCopy = ReturnType<typeof createProfileCopy>;

export type ProfilePageCopy = Copy & { readonly profile: ProfileCopy };

const cache = new Map<Locale, ProfilePageCopy>();

/** The whole copy with the segment profile block. */
export function profileCopyFor(locale: Locale): ProfilePageCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = { ...copyFor(locale), profile: createProfileCopy(locale) };
  cache.set(locale, created);
  return created;
}
