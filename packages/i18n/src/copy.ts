import { LOCALE_TAGS, type Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export const CATEGORY_KEYS = ["hsr", "ld", "night", "rfast", "reg", "sbahn", "foreign"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const ERROR_CODES = [
  "upstream_unavailable",
  "unreachable",
  "unreadable",
  "server_error",
  "no_live_server",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface CategoryCopy {
  readonly legend: string;
  readonly badge: string;
}

function createCategories(locale: Locale): Readonly<Record<CategoryKey, CategoryCopy>> {
  const o = { locale };
  return {
    hsr: { legend: m.category_hsr_legend({}, o), badge: m.category_hsr_badge({}, o) },
    ld: { legend: m.category_ld_legend({}, o), badge: m.category_ld_badge({}, o) },
    night: { legend: m.category_night_legend({}, o), badge: m.category_night_badge({}, o) },
    rfast: { legend: m.category_rfast_legend({}, o), badge: m.category_rfast_badge({}, o) },
    reg: { legend: m.category_reg_legend({}, o), badge: m.category_reg_badge({}, o) },
    sbahn: { legend: m.category_sbahn_legend({}, o), badge: m.category_sbahn_badge({}, o) },
    foreign: { legend: m.category_foreign_legend({}, o), badge: m.category_foreign_badge({}, o) },
  };
}

export interface AttributionParts {
  readonly holders: readonly string[];
  readonly mirror: string | null;
}

const MIRRORED_BY = /,\s*mirrored by\s+/i;
const HOLDER_JOIN = /\s*,\s*|\s+and\s+/i;

export function attributionParts(attribution: string): AttributionParts {
  const [holders = "", mirror] = String(attribution).trim().split(MIRRORED_BY);
  return {
    holders: holders
      .split(HOLDER_JOIN)
      .map((holder) => holder.trim())
      .filter((holder) => holder.length > 0),
    mirror: mirror?.trim() || null,
  };
}

function createTrainCopy(locale: Locale) {
  const o = { locale };
  const list = new Intl.ListFormat(LOCALE_TAGS[locale], { type: "conjunction" });
  return {
    follow: m.card_follow({}, o),
    route: m.card_route({}, o),
    share: m.card_share({}, o),
    shareCopied: m.card_share_copied({}, o),
    shareFailed: m.card_share_failed({}, o),
    shareTitle: (train: string) => m.card_share_title({ train }, o),
    positionHow: m.card_position_how({}, o),
    positionHowRealtime: (source: string) => m.card_position_how_realtime({ source }, o),
    positionHowTimetable: m.card_position_how_timetable({}, o),
    notOnMap: m.card_not_on_map({}, o),
    allStops: (count: number) => m.card_all_stops({ count }, o),
    fewerStops: m.card_fewer_stops({}, o),
    stopList: m.card_stop_list({}, o),
    cancelled: m.card_cancelled({}, o),
    cancelledNote: m.card_cancelled_note({}, o),
    stopCancelled: m.card_stop_cancelled({}, o),
    endsEarly: (count: number, stop: string) => m.card_ends_early({ count, stop }, o),
    stopsCancelled: (count: number) => m.card_stops_cancelled({ count }, o),
    dayLater: (count: number) => m.card_day_later({ count }, o),
    added: m.card_added({}, o),
    badge: { bus: m.card_badge_bus({}, o), urban: m.card_badge_urban({}, o) },
    vehicle: m.card_vehicle({}, o),
    vehicleMissing: m.card_vehicle_missing({}, o),
    vehicleMissingNote: m.card_vehicle_missing_note({}, o),
    vehicleCars: (count: number) => m.card_vehicle_cars({ count }, o),
    confidence: {
      high: m.card_confidence_high({}, o),
      medium: m.card_confidence_medium({}, o),
      low: m.card_confidence_low({}, o),
    },
    vehicleSource: (source: string) => m.card_vehicle_source({ source }, o),
    vehicleRelatedModel: (name: string) => m.bodies_related_model({ name }, o),
    photoMissing: m.card_photo_missing({}, o),
    photoBy: (author: string) => m.card_photo_by({ author }, o),
    line: (line: string) => m.card_line({ line }, o),
    trainNumber: (number: string) => m.card_train_number({ number }, o),
    to: (to: string) => m.card_route_to({ to }, o),
    attribution: (attribution: string) => {
      const { holders, mirror } = attributionParts(attribution);
      const joined = holders.length > 0 ? list.format(holders) : String(attribution).trim();
      return mirror === null ? joined : m.card_attribution_mirror({ holders: joined, mirror }, o);
    },
    realtimeSource: (source: string) => m.card_realtime_source({ source }, o),
    timetableSource: (source: string) => m.card_timetable_source({ source }, o),
    refreshFailed: m.card_refresh_failed({}, o),
    loadError: m.card_load_error({}, o),
    retry: m.card_retry({}, o),
    loading: m.card_loading({}, o),
    arrival: m.card_arrival({}, o),
    departure: m.card_departure({}, o),
    scheduled: m.card_scheduled({}, o),
    expected: m.card_expected({}, o),
    delay: m.card_delay({}, o),
    station: {
      label: m.station_label({}, o),
      back: (train: string) => m.station_back({ train }, o),
      thisTrain: m.station_this_train({}, o),
      board: m.station_board({}, o),
    },
  };
}

export function createCopy(locale: Locale) {
  const o = { locale };
  return {
    locale,
    brand: {
      name: m.brand_name({}, o),
      tagline: m.brand_tagline({}, o),
      title: m.brand_title({}, o),
      description: m.brand_description({}, o),
    },
    language: { label: m.language_label({}, o) },
    journeys: { open: m.journeys_open({}, o) },
    map: {
      label: m.map_label({}, o),
      zoomGroup: m.map_zoom_group({}, o),
      zoomIn: m.map_zoom_in({}, o),
      zoomOut: m.map_zoom_out({}, o),
      error: {
        title: m.map_error_title({}, o),
        body: m.map_error_body({}, o),
        reload: m.map_error_reload({}, o),
      },
    },
    search: {
      label: m.search_label({}, o),
      placeholder: m.search_placeholder({}, o),
      placeholderShort: m.search_placeholder_short({}, o),
      clear: m.search_clear({}, o),
      results: m.search_results_label({}, o),
      groups: {
        station: m.search_group_station({}, o),
        train: m.search_group_train({}, o),
        line: m.search_group_line({}, o),
        place: m.search_group_place({}, o),
      },
      loading: m.search_loading({}, o),
      empty: (query: string) => m.search_empty({ query }, o),
      error: m.search_error({}, o),
      retry: m.search_retry({}, o),
      trainNumber: (number: string) => m.search_train_number({ number }, o),
      trainRoute: (origin: string, destination: string) =>
        m.search_train_route({ origin, destination }, o),
      trainRunning: (time: string) => m.search_train_running({ time }, o),
      trainDeparts: (time: string) => m.search_train_departs({ time }, o),
      trainArrived: (time: string) => m.search_train_arrived({ time }, o),
      trainsToday: (count: number) => m.search_trains_today({ count }, o),
      land: m.search_land({}, o),
      landClear: (land: string) => m.search_land_clear({ land }, o),
      stationLines: m.search_station_lines({}, o),
      stationShare: m.search_station_share({}, o),
      stationClose: m.search_station_close({}, o),
      stationMissing: m.search_station_missing({}, o),
      stationMissingBody: m.search_station_missing_body({}, o),
      stationFailed: m.search_station_failed({}, o),
      stationLoading: m.search_station_loading({}, o),
    },
    mode: {
      label: m.mode_label({}, o),
      category: m.mode_category({}, o),
      delay: m.mode_delay({}, o),
      operator: m.mode_operator({}, o),
    },
    labels: {
      label: m.label_label({}, o),
      off: m.label_off({}, o),
      line: m.label_line({}, o),
      delay: m.label_delay({}, o),
      hint: m.label_hint({}, o),
    },
    soon: { tag: m.soon({}, o), description: m.soon_description({}, o) },
    style: {
      label: m.style_label({}, o),
      dark: m.style_dark({}, o),
      light: m.style_light({}, o),
      satellite: m.style_satellite({}, o),
      terrain: m.style_terrain({}, o),
      terrain3d: m.style_terrain_3d({}, o),
    },
    layers: { open: m.layers_open({}, o), title: m.layers_title({}, o) },
    stage: {
      national: m.stage_national({}, o),
      region: m.stage_region({}, o),
      city: m.stage_city({}, o),
    },
    live: {
      loading: m.live_loading({}, o),
      live: m.live_live({}, o),
      recorded: m.live_recorded({}, o),
      stale: m.live_stale({}, o),
      error: m.live_error({}, o),
      openStatus: (state: string) => m.status_open({ state }, o),
      errors: {
        upstream_unavailable: m.live_error_upstream_unavailable({}, o),
        unreachable: m.live_error_unreachable({}, o),
        unreadable: m.live_error_unreadable({}, o),
        server_error: m.live_error_server_error({}, o),
        no_live_server: m.live_error_no_live_server({}, o),
      } satisfies Record<ErrorCode, string>,
    },
    legend: {
      label: m.legend_label({}, o),
      title: m.legend_title({}, o),
      total: m.legend_total({}, o),
      realtime: m.legend_realtime({}, o),
      untracked: (count: number) => m.legend_untracked({ count }, o),
      show: m.legend_show({}, o),
      delay: {
        ok: m.legend_delay_ok({}, o),
        minor: m.legend_delay_minor({}, o),
        major: m.legend_delay_major({}, o),
        severe: m.legend_delay_severe({}, o),
        none: m.legend_delay_none({}, o),
        foreign: m.category_foreign_legend({}, o),
      },
    },
    categories: createCategories(locale),
    delay: {
      onTime: m.delay_on_time({}, o),
      noData: m.delay_no_data({}, o),
      minutes: m.delay_minutes({}, o),
      early: m.delay_early({}, o),
    },
    card: {
      label: m.card_label({}, o),
      close: m.card_close({}, o),
      expand: m.card_expand({}, o),
      collapse: m.card_collapse({}, o),
      train: m.card_train({}, o),
      realtime: m.card_realtime({}, o),
      timetableOnly: m.card_timetable_only({}, o),
      from: m.card_from({}, o),
      nextStop: m.card_next_stop({}, o),
      now: m.card_now({}, o),
      arrived: m.card_arrived({}, o),
      notDeparted: m.card_not_departed({}, o),
      atStop: m.card_at_stop({}, o),
      toNextStop: (minutes: number) =>
        minutes <= 1
          ? m.card_to_next_stop_soon({}, o)
          : m.card_to_next_stop_minutes({ minutes }, o),
      departsAt: (clock: string) => m.card_departs_at({ clock }, o),
      platform: (track: string) => m.card_platform({ track }, o),
      platformChanged: (track: string, was: string) => m.card_platform_changed({ track, was }, o),
      operator: m.card_operator({}, o),
      operatorMissing: m.card_operator_missing({}, o),
      positionEstimated: m.card_position_estimated({}, o),
      dataFrom: (clock: string, day: string) => m.card_data_from({ clock, day }, o),
      recordedReplay: m.card_recorded_replay({}, o),
      staleData: m.card_stale_data({}, o),
      ended: m.card_ended({}, o),
      detailUnavailable: m.card_detail_unavailable({}, o),
      notDrawn: m.card_not_drawn({}, o),
    },
    train: createTrainCopy(locale),
    stats: { open: m.stats_open({}, o) },
    playback: {
      open: m.playback_open({}, o),
      label: m.playback_label({}, o),
      backToLive: m.playback_back_to_live({}, o),
      cardNote: m.playback_card_note({}, o),
    },
    speed: {
      label: m.speed_label({}, o),
      standing: m.speed_standing({}, o),
      basisRealtime: m.speed_basis_realtime({}, o),
      basisTimetable: m.speed_basis_timetable({}, o),
      basisPlayback: m.speed_basis_playback({}, o),
    },
    searchField: {
      placeholderMedium: m.search_field_placeholder_medium({}, o),
      placeholderTiny: m.search_field_placeholder_tiny({}, o),
    },
    operatorMode: {
      label: m.operator_mode_label({}, o),
      hint: m.operator_mode_hint({}, o),
      other: m.operator_mode_other({}, o),
      unknown: m.operator_mode_unknown({}, o),
    },
    attribution: {
      label: m.attribution_label({}, o),
      mapData: m.attribution_map_data({}, o),
      trains: m.attribution_trains({}, o),
      openStreetMap: m.attribution_open_street_map({}, o),
      openFreeMap: m.attribution_open_free_map({}, o),
      openMapTiles: m.attribution_open_map_tiles({}, o),
      delfi: m.attribution_delfi({}, o),
      gtfsDe: m.attribution_gtfs_de({}, o),
      timetable: m.attribution_timetable({}, o),
      realtime: m.attribution_realtime({}, o),
      borders: m.attribution_borders({}, o),
      licenceChanged: m.attribution_licence_changed({}, o),
      naturalEarth: m.attribution_natural_earth({}, o),
      imagery: m.attribution_imagery({}, o),
      imageryProviders: m.attribution_imagery_providers({}, o),
      elevation: m.attribution_elevation({}, o),
      stationNames: m.attribution_station_names({}, o),
      dbStada: m.attribution_db_stada({}, o),
      show: m.attribution_show({}, o),
      hide: m.attribution_hide({}, o),
    },
    terrain: {
      buildings: m.terrain_buildings_3d({}, o),
      slowHint: m.terrain_slow_hint({}, o),
    },
    photos: {
      creditsTitle: m.photos_credits_title({}, o),
      creditsIntro: m.photos_credits_intro({}, o),
      creditsCount: (count: number) => m.photos_credits_count({ count }, o),
      creditsEmpty: m.photos_credits_empty({}, o),
      creditsLoading: m.photos_credits_loading({}, o),
      creditsError: m.photos_credits_error({}, o),
      creditsRetry: m.photos_credits_retry({}, o),
      creditsBack: m.photos_credits_back({}, o),
      creditsLink: m.photos_credits_link({}, o),
      author: m.photos_author({}, o),
      licence: m.photos_licence({}, o),
      title: m.photos_title({}, o),
      cropped: m.photos_cropped({}, o),
    },
    legal: {
      sourcesLink: m.legal_sources_link({}, o),
      privacyLink: m.legal_privacy_link({}, o),
      imprintLink: m.legal_imprint_link({}, o),
      notAffiliatedShort: m.legal_not_affiliated_short({}, o),
    },
  };
}

export type Copy = ReturnType<typeof createCopy>;

const cache = new Map<Locale, Copy>();

export function copyFor(locale: Locale): Copy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = createCopy(locale);
  cache.set(locale, created);
  return created;
}
