import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export function createA11yCopy(locale: Locale) {
  const o = { locale };
  return {
    skipToSearch: m.a11y_skip_search({}, o),
    mapKeys: m.a11y_map_keys({}, o),
    retryKey: m.a11y_retry_key({}, o),
    skipToInView: m.a11y_skip_inview({}, o),
    shortcuts: m.a11y_shortcuts_label({}, o),
    shortcutsHint: m.a11y_shortcuts_hint({}, o),
    sourceList: m.a11y_source_list({}, o),
    viewSummary: (count: number) =>
      count === 0 ? m.a11y_view_summary_none({}, o) : m.a11y_view_summary({ count }, o),
    results: (count: number) => m.a11y_results({ count }, o),
  };
}

export type A11yCopy = ReturnType<typeof createA11yCopy>;

const cache = new Map<Locale, A11yCopy>();

export function a11yCopyFor(locale: Locale): A11yCopy {
  let copy = cache.get(locale);
  if (copy === undefined) {
    copy = createA11yCopy(locale);
    cache.set(locale, copy);
  }
  return copy;
}
