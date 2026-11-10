import { type Copy, copyFor } from "./copy.ts";
import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

/** The journey planner's strings (WP-8.2), loaded with the planner panel and not with the entry. */
export function createJourneysCopy(locale: Locale) {
  const o = { locale };
  return {
    open: m.journeys_open({}, o),
    title: m.journeys_title({}, o),
    close: m.journeys_close({}, o),
    from: m.journeys_from({}, o),
    to: m.journeys_to({}, o),
    fromPlaceholder: m.journeys_from_placeholder({}, o),
    toPlaceholder: m.journeys_to_placeholder({}, o),
    swap: m.journeys_swap({}, o),
    depart: m.journeys_depart({}, o),
    arrive: m.journeys_arrive({}, o),
    timeMode: m.journeys_time_mode({}, o),
    time: m.journeys_time({}, o),
    now: m.journeys_now({}, o),
    categories: m.journeys_categories({}, o),
    filters: m.journeys_filters({}, o),
    filtersAll: m.journeys_filters_all({}, o),
    filtersKinds: (count: number) => m.journeys_filters_kinds({ count }, o),
    categoryNone: m.journeys_category_none({}, o),
    operator: m.journeys_operator({}, o),
    operatorPlaceholder: m.journeys_operator_placeholder({}, o),
    operatorHint: m.journeys_operator_hint({}, o),
    search: m.journeys_search({}, o),
    searching: m.journeys_searching({}, o),
    needStations: m.journeys_need_stations({}, o),
    sameStation: m.journeys_same_station({}, o),
    noStopId: (station: string) => m.journeys_no_stop_id({ station }, o),
    stationNoStop: m.journeys_station_no_stop({}, o),
    stationResults: m.journeys_station_results({}, o),
    stationNone: (query: string) => m.journeys_station_none({ query }, o),
    stationLoading: m.journeys_station_loading({}, o),
    stationError: m.journeys_station_error({}, o),
    earlier: m.journeys_earlier({}, o),
    later: m.journeys_later({}, o),
    results: m.journeys_results({}, o),
    empty: m.journeys_empty({}, o),
    removed: (count: number) => m.journeys_removed({ count }, o),
    partial: m.journeys_partial({}, o),
    errors: {
      unavailable: m.journeys_error({}, o),
      busy: m.journeys_error_busy({}, o),
      stop: m.journeys_error_stop({}, o),
      rejected: m.journeys_error_rejected({}, o),
      limited: m.journeys_error_limited({}, o),
    },
    retry: m.journeys_retry({}, o),
    durationHm: (hours: number, minutes: number) =>
      m.journeys_duration_hm({ hours: String(hours), minutes: String(minutes) }, o),
    durationM: (minutes: number) => m.journeys_duration_m({ minutes: String(minutes) }, o),
    durationH: (hours: number) => m.journeys_duration_h({ hours: String(hours) }, o),
    departure: m.journeys_departure({}, o),
    arrival: m.journeys_arrival({}, o),
    widen: m.journeys_widen({}, o),
    direct: m.journeys_direct({}, o),
    changes: (count: number) => m.journeys_changes({ count }, o),
    trainNumber: (number: string) => m.journeys_train_number({ number }, o),
    line: (line: string) => m.journeys_line({ line }, o),
    towards: (headsign: string) => m.journeys_towards({ headsign }, o),
    platform: (track: string) => m.journeys_platform({ track }, o),
    walk: (minutes: number) => m.journeys_walk({ minutes: String(minutes) }, o),
    changeTime: (minutes: number) => m.journeys_change_time({ minutes: String(minutes) }, o),
    cancelled: m.journeys_cancelled({}, o),
    timetableOnly: m.journeys_timetable_only({}, o),
    liveTrain: m.journeys_live_train({}, o),
    tags: {
      fastest: m.journeys_tag_fastest({}, o),
      fewestChanges: m.journeys_tag_fewest_changes({}, o),
    },
    reliability: {
      share: (share: string, day: string | null) =>
        day === null
          ? m.journeys_reliability_plain({ share }, o)
          : m.journeys_reliability({ share, day }, o),
      train: (train: string, share: string, day: string | null) =>
        day === null
          ? m.journeys_reliability_train_plain({ train, share }, o)
          : m.journeys_reliability_train({ train, share, day }, o),
      thin: (count: number) => m.journeys_reliability_thin({ count }, o),
      unrated: (count: number) => m.journeys_reliability_unrated({ count }, o),
      runs: (count: number) => m.journeys_reliability_runs({ count }, o),
      partial: (count: number) => m.journeys_reliability_partial({ count }, o),
      rule: m.journeys_reliability_rule({}, o),
      loading: m.journeys_reliability_loading({}, o),
      missing: {
        no_number: m.journeys_reliability_no_number({}, o),
        no_observations: m.journeys_reliability_no_observations({}, o),
        ambiguous: m.journeys_reliability_ambiguous({}, o),
        unavailable: m.journeys_reliability_unavailable({}, o),
      },
    },
    selected: m.journeys_selected({}, o),
    show: m.journeys_show({}, o),
    back: m.journeys_back({}, o),
    source: m.journeys_source({}, o),
  };
}

export type JourneysCopy = ReturnType<typeof createJourneysCopy>;

export type JourneysPageCopy = Omit<Copy, "journeys"> & { readonly journeys: JourneysCopy };

const cache = new Map<Locale, JourneysPageCopy>();

/** The whole copy with the planner block in full, for components inside the lazily loaded planner. */
export function journeysCopyFor(locale: Locale): JourneysPageCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = { ...copyFor(locale), journeys: createJourneysCopy(locale) };
  cache.set(locale, created);
  return created;
}
