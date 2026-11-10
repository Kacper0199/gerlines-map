import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export const COMPASS_POINTS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

export function createInViewCopy(locale: Locale) {
  const o = { locale };
  return {
    title: m.inview_title({}, o),
    open: m.inview_open({}, o),
    close: m.inview_close({}, o),
    expand: m.inview_expand({}, o),
    collapse: m.inview_collapse({}, o),
    hint: m.inview_hint({}, o),
    empty: m.inview_empty({}, o),
    loading: m.inview_loading({}, o),
    update: m.inview_update({}, o),
    failed: m.inview_failed({}, o),
    metres: (value: string) => m.inview_m({ value }, o),
    kilometres: (value: string) => m.inview_km({ value }, o),
    centre: m.inview_centre({}, o),
    directions: {
      n: m.inview_dir_n({}, o),
      ne: m.inview_dir_ne({}, o),
      e: m.inview_dir_e({}, o),
      se: m.inview_dir_se({}, o),
      s: m.inview_dir_s({}, o),
      sw: m.inview_dir_sw({}, o),
      w: m.inview_dir_w({}, o),
      nw: m.inview_dir_nw({}, o),
    } as Readonly<Record<CompassPoint, string>>,
  };
}

export type InViewCopy = ReturnType<typeof createInViewCopy>;

const cache = new Map<Locale, InViewCopy>();

export function inViewCopyFor(locale: Locale): InViewCopy {
  let copy = cache.get(locale);
  if (copy === undefined) {
    copy = createInViewCopy(locale);
    cache.set(locale, copy);
  }
  return copy;
}
