import { type Copy, copyFor } from "./copy.ts";
import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

/** The statistics panel's strings, loaded with the panel and not with the entry. */
export function createStatsCopy(locale: Locale) {
  const o = { locale };
  return {
    open: m.stats_open({}, o),
    title: m.stats_title({}, o),
    close: m.stats_close({}, o),
    sheetExpand: m.stats_sheet_expand({}, o),
    sheetCollapse: m.stats_sheet_collapse({}, o),
    area: {
      label: m.stats_area_label({}, o),
      network: m.stats_area_network({}, o),
      land: m.stats_area_land({}, o),
      station: m.stats_area_station({}, o),
      line: m.stats_area_line({}, o),
      train: m.stats_area_train({}, o),
    },
    landLabel: m.stats_land_label({}, o),
    landPlaceholder: m.stats_land_placeholder({}, o),
    station: {
      label: m.stats_station_label({}, o),
      placeholder: m.stats_station_placeholder({}, o),
      none: m.stats_station_none({}, o),
    },
    lineLabel: m.stats_line_label({}, o),
    lineInvalid: m.stats_line_invalid({}, o),
    lineHint: m.stats_line_hint({}, o),
    trainLabel: m.stats_train_label({}, o),
    trainInvalid: m.stats_train_invalid({}, o),
    trainHint: m.stats_train_hint({}, o),
    show: m.stats_show({}, o),
    period: {
      label: m.stats_period_label({}, o),
      today: m.stats_period_today({}, o),
      days7: m.stats_period_days7({}, o),
      days30: m.stats_period_days30({}, o),
      month: m.stats_period_month({}, o),
      custom: m.stats_period_custom({}, o),
      monthPrevious: m.stats_month_previous({}, o),
      monthNext: m.stats_month_next({}, o),
      from: m.stats_custom_from({}, o),
      to: m.stats_custom_to({}, o),
      days: (count: number) => m.stats_period_days({ count }, o),
      range: (from: string, to: string) => m.stats_period_range({ from, to }, o),
      problem: {
        order: m.stats_range_order({}, o),
        "too-long": m.stats_range_too_long({}, o),
        incomplete: m.stats_range_incomplete({}, o),
      },
    },
    scope: {
      train: (number: string) => m.stats_scope_train({ number }, o),
      line: (line: string) => m.stats_scope_line({ line }, o),
    },
    punctual: {
      title: m.stats_punctual({}, o),
      rule: m.stats_punctual_rule({}, o),
      rule16: m.stats_punctual16({}, o),
    },
    fact: {
      observedArrivals: m.stats_fact_observed_arrivals({}, o),
      stops: m.stats_fact_stops({}, o),
      observed: m.stats_fact_observed({}, o),
      cancelled: m.stats_fact_cancelled({}, o),
      cancelledShare: m.stats_fact_cancelled_share({}, o),
      mean: m.stats_fact_mean({}, o),
      median: m.stats_fact_median({}, o),
      p90: m.stats_fact_p90({}, o),
      max: m.stats_fact_max({}, o),
      runs: m.stats_fact_runs({}, o),
      departures: m.stats_fact_departures({}, o),
      departuresPunctual: m.stats_fact_departures_punctual({}, o),
    },
    delay: {
      title: m.stats_delay_title({}, o),
      note: m.stats_delay_note({}, o),
      axis: m.stats_delay_axis({}, o),
      binRange: (from: string, to: string) => m.stats_delay_bin_range({ from, to }, o),
      binOpen: (from: string) => m.stats_delay_bin_open({ from }, o),
      binBelow: (to: string) => m.stats_delay_bin_below({ to }, o),
      perMinute: m.stats_delay_per_minute({}, o),
      share: m.stats_share_of_observed({}, o),
    },
    category: {
      title: m.stats_category_title({}, o),
      note: m.stats_category_note({}, o),
      urban: m.stats_category_urban({}, o),
      bus: m.stats_category_bus({}, o),
      other: m.stats_category_other({}, o),
      none: m.stats_category_none({}, o),
      covers: m.stats_category_covers({}, o),
      arrivals: (count: number, formatted: string) =>
        m.stats_arrivals_count({ count, formatted }, o),
    },
    hour: {
      title: m.stats_hour_title({}, o),
      note: m.stats_hour_note({}, o),
      average: (share: string) => m.stats_hour_average({ share }, o),
    },
    day: { title: m.stats_day_title({}, o), note: m.stats_day_note({}, o) },
    operators: { title: m.stats_operators_title({}, o), unknown: m.stats_operator_unknown({}, o) },
    under: (value: string) => m.stats_share_under({ value }, o),
    groupsTitle: m.stats_groups_title({}, o),
    chartHint: m.stats_chart_hint({}, o),
    table: {
      toggle: m.stats_table_toggle({}, o),
      hour: m.stats_table_hour({}, o),
      day: m.stats_table_day({}, o),
      share: m.stats_table_share({}, o),
    },
    loading: m.stats_loading({}, o),
    retryIn: (seconds: number) => m.stats_retry_in({ seconds }, o),
    updating: m.stats_updating({}, o),
    errors: {
      "not-configured": m.stats_error_not_configured({}, o),
      "rate-limited": m.stats_error_rate_limited({}, o),
      invalid: m.stats_error_invalid({}, o),
      "not-found": m.stats_error_not_found({}, o),
      unavailable: m.stats_error_unavailable({}, o),
      unreachable: m.stats_error_unreachable({}, o),
      unreadable: m.stats_error_unreadable({}, o),
    },
    empty: {
      title: m.stats_empty_title({}, o),
      "no-stops": m.stats_empty_no_stops({}, o),
      "no-realtime": m.stats_empty_no_realtime({}, o),
      "no-arrivals": m.stats_empty_no_arrivals({}, o),
      newDay: m.stats_empty_new_day({}, o),
    },
    provenance: {
      source: m.stats_source({}, o),
      refreshed: (clock: string, day: string) => m.stats_refreshed({ clock, day }, o),
      refreshedUnknown: m.stats_refreshed_unknown({}, o),
      lag: (minutes: number) => m.stats_lag({ minutes }, o),
    },
    method: {
      title: m.stats_method_title({}, o),
      rule: m.stats_method_rule({}, o),
      gap: m.stats_method_gap({}, o),
      history: m.stats_history_credit({}, o),
      outside: (foreign: string, unassigned: string) => m.stats_outside({ foreign, unassigned }, o),
      outsideForeign: (foreign: string) => m.stats_outside_foreign({ foreign }, o),
      outsideUnassigned: (unassigned: string) => m.stats_outside_unassigned({ unassigned }, o),
      estimated: (count: string) => m.stats_estimated({ count }, o),
    },
  };
}

export type StatsCopy = ReturnType<typeof createStatsCopy>;

export type StatsPageCopy = Omit<Copy, "stats"> & { readonly stats: StatsCopy };

const cache = new Map<Locale, StatsPageCopy>();

/** The whole copy with the statistics block in full, for components inside the lazily loaded panel. */
export function statsCopyFor(locale: Locale): StatsPageCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = { ...copyFor(locale), stats: createStatsCopy(locale) };
  cache.set(locale, created);
  return created;
}
