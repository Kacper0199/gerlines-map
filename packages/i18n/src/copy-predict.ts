import { type Copy, copyFor } from "./copy.ts";
import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

/** The name of the history set the B1 table is trained on, as the API sends it. */
export const PIEBRO_SOURCE_NAME = "piebro/deutsche-bahn-data";

/** The train card's forecast strings (WP-7.5), loaded with the lazy card and not with the entry. */
export function createPredictCopy(locale: Locale) {
  const o = { locale };
  const piebro = m.predict_attribution_piebro({}, o);
  return {
    title: m.predict_title({}, o),
    titleFeed: m.predict_title_feed({}, o),
    from: (delay: string, stop: string) => m.predict_from({ delay, stop }, o),
    value: (expected: string, upper: string) => m.predict_value({ expected, upper }, o),
    level: {
      train: m.predict_level_train({}, o),
      stop: m.predict_level_stop({}, o),
      category: m.predict_level_category({}, o),
    },
    spread: {
      train: m.predict_spread_train({}, o),
      stop: m.predict_spread_stop({}, o),
      category: m.predict_spread_category({}, o),
    },
    more: (count: number) => m.predict_more({ count }, o),
    note: (from: string, to: string) => m.predict_note({ from, to }, o),
    noteFeed: (feed: string, from: string, to: string) =>
      m.predict_note_feed({ feed, from, to }, o),
    noteRest: m.predict_note_rest({}, o),
    source: (attribution: string) => m.predict_source({ attribution }, o),
    attribution: (sourceName: string, sent: string) =>
      sourceName === PIEBRO_SOURCE_NAME ? piebro : sent,
    licence: m.predict_licence({}, o),
    method: m.predict_method({}, o),
    methodFeed: m.predict_method_feed({}, o),
  };
}

export type PredictCopy = ReturnType<typeof createPredictCopy>;

export type PredictPageCopy = Copy & { readonly predict: PredictCopy };

const cache = new Map<Locale, PredictPageCopy>();

/** The whole copy with the forecast block, for the lazily loaded train card. */
export function predictCopyFor(locale: Locale): PredictPageCopy {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = { ...copyFor(locale), predict: createPredictCopy(locale) };
  cache.set(locale, created);
  return created;
}
