import { type CategoryKey, copyFor, type Locale } from "@gerlines/i18n";
import type { LocaleOption } from "../src/index.ts";

export type SheetLocale = Locale;

export const SAMPLE = {
  line: "ICE 379",
  destination: "Basel SBB",
  operator: "DB Fernverkehr AG",
  delayMinutes: 51,
  predicted: "21:35",
  scheduled: "20:44",
  stop: "Frankfurt (Main) Hbf",
  passedStop: "Hanau Hbf",
  passedTime: "21:16",
  platform: "8",
  platformWas: "7",
  untrackedCount: 88,
  longStopName: "Brieskow-Finkenheerd, Kraftwerk Finkenheerd Bhf",
  longStopSource: "DELFI stops.txt of 2026-10-19, stop de:12067:900311233",
  counts: { hsr: 151, ld: 40, night: 3, rfast: 463, reg: 610, sbahn: 621, foreign: 777 },
  total: 2665,
  realtime: 2234,
} as const;

const SPECIMEN = {
  searchLabel: "Search for a train, line or station",
  searchPlaceholder: "Train, line or station",
  clearSearch: "Clear search",
  colourBy: "Colour by",
  modes: { category: "Category", delay: "Delay", operator: "Operator" },
  follow: "Follow",
  route: "Route",
  share: "Share",
  styles: { dark: "Dark", light: "Light", satellite: "Satellite", terrain: "Terrain" },
  cancelled: "Cancelled",
  dialogTitle: "Share this train",
  dialogBody: "The link opens the map on this train and keeps the language you chose.",
  confirm: "Copy link",
  cancel: "Cancel",
  menuLabel: "More actions",
  tooltipTrigger: "Route",
  tooltip: "Show the route of this train on the map",
  popoverTrigger: "How is the position found",
  scheduled: "Scheduled",
  predicted: "Predicted",
  note: "Labels without a message key yet stay English in every language until WP-4.2 and WP-4.3 add them.",
} as const;

export function stringsFor(locale: SheetLocale) {
  const copy = copyFor(locale);
  const keys = Object.keys(copy.categories) as CategoryKey[];
  return {
    ...SPECIMEN,
    locale,
    brand: copy.brand.name,
    tagline: copy.brand.tagline,
    languageLabel: copy.language.label,
    legendTitle: copy.legend.title,
    total: copy.legend.total,
    realtime: copy.legend.realtime,
    untracked: copy.legend.untracked(SAMPLE.untrackedCount),
    categories: Object.fromEntries(keys.map((key) => [key, copy.categories[key].legend])) as Record<
      CategoryKey,
      string
    >,
    categoryBadge: copy.categories.hsr.badge,
    delay: copy.delay,
    trainTitle: copy.card.label,
    realtimeState: copy.card.realtime,
    timetableOnly: copy.card.timetableOnly,
    nextStop: copy.card.nextStop,
    nowLabel: copy.card.now,
    toNextStop: copy.card.toNextStop(1),
    platformChanged: copy.card.platformChanged(SAMPLE.platform, SAMPLE.platformWas),
    close: copy.card.close,
    expandSheet: copy.card.expand,
    collapseSheet: copy.card.collapse,
    positionEstimated: copy.card.positionEstimated,
    stale: copy.live.stale,
    searchError: copy.live.errors.upstream_unavailable,
  };
}

export type SheetStrings = ReturnType<typeof stringsFor>;

export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { code: "en", short: "EN", name: "English" },
  { code: "de", short: "DE", name: "Deutsch" },
  { code: "pl", short: "PL", name: "Polski" },
];
