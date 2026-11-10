import { type Copy, copyFor } from "./copy.ts";
import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

/** The data status popover strings (WP-9.7a), loaded with the lazy popover and not with the entry. */
export function createStatusCopy(locale: Locale) {
  const o = { locale };
  return {
    title: m.status_title({}, o),
    loading: m.status_loading({}, o),
    error: m.status_error({}, o),
    notConfigured: m.status_not_configured({}, o),
    retry: m.status_retry({}, o),
    retryIn: (seconds: number) => m.status_retry_in({ seconds }, o),
    asOf: (time: string) => m.status_as_of({ time }, o),
    refreshFailed: m.status_refresh_failed({}, o),
    live: {
      title: m.status_live_title({}, o),
      age: (seconds: number) => m.status_live_age({ seconds }, o),
      since: (time: string) => m.status_live_since({ time }, o),
      none: m.status_live_none({}, o),
      noReading: m.status_live_no_reading({}, o),
    },
    kind: {
      timetable: m.status_kind_timetable({}, o),
      realtime: m.status_kind_realtime({}, o),
      iris: m.status_kind_iris({}, o),
      neighbours: m.status_kind_neighbours({}, o),
    },
    state: {
      ok: m.status_state_ok({}, o),
      stale: m.status_state_stale({}, o),
      down: m.status_state_down({}, o),
      not_recorded: m.status_state_not_recorded({}, o),
    },
    recorded: (time: string) => m.status_recorded({ time }, o),
    onMap: (time: string) => m.status_on_map({ time }, o),
    notOnMap: m.status_not_on_map({}, o),
    note: (min: number, max: number) => m.status_note({ min, max }, o),
    sourcesLink: m.status_sources_link({}, o),
    country: {
      DE: m.status_country_de({}, o),
      NL: m.status_country_nl({}, o),
      BE: m.status_country_be({}, o),
      FR: m.status_country_fr({}, o),
      CH: m.status_country_ch({}, o),
      CZ: m.status_country_cz({}, o),
      PL: m.status_country_pl({}, o),
    } as Readonly<Record<string, string>>,
  };
}

export type StatusCopy = ReturnType<typeof createStatusCopy>;

export type StatusPageCopy = Copy & { readonly status: StatusCopy };

const cache = new Map<Locale, StatusPageCopy>();

/** The whole copy with the data status block. */
export function statusCopyFor(locale: Locale): StatusPageCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = { ...copyFor(locale), status: createStatusCopy(locale) };
  cache.set(locale, created);
  return created;
}
