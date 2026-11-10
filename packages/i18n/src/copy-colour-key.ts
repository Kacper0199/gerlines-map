import type { Locale } from "./locale.ts";
import { m } from "./paraglide/messages.js";

export function createColourKeyCopy(locale: Locale) {
  const o = { locale };
  return {
    hidden: m.colour_key_hidden({}, o),
    label: {
      category: m.colour_key_category_label({}, o),
      delay: m.colour_key_delay_label({}, o),
      operator: m.colour_key_operator_label({}, o),
    },
    category: {
      hsr: m.colour_key_hsr({}, o),
      ld: m.colour_key_ld({}, o),
      night: m.colour_key_night({}, o),
      rfast: m.colour_key_rfast({}, o),
      reg: m.colour_key_reg({}, o),
      sbahn: m.colour_key_sbahn({}, o),
      foreign: m.colour_key_foreign({}, o),
    },
    delay: {
      ok: m.colour_key_delay_ok({}, o),
      minor: m.colour_key_delay_minor({}, o),
      major: m.colour_key_delay_major({}, o),
      severe: m.colour_key_delay_severe({}, o),
      none: m.colour_key_delay_none({}, o),
    },
    operator: {
      other: m.colour_key_operator_other({}, o),
      unknown: m.colour_key_operator_unknown({}, o),
    },
  };
}

export type ColourKeyCopy = ReturnType<typeof createColourKeyCopy>;

const cache = new Map<Locale, ColourKeyCopy>();

export function colourKeyCopyFor(locale: Locale): ColourKeyCopy {
  let copy = cache.get(locale);
  if (copy === undefined) {
    copy = createColourKeyCopy(locale);
    cache.set(locale, copy);
  }
  return copy;
}
