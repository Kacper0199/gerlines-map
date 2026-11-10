import { LOCALE_TAGS, type Locale } from "./locale.ts";

const TIME_ZONE = "Europe/Berlin";
const NO_BREAK_SPACE = "\u00a0";

export interface CountPart {
  readonly type: Intl.NumberFormatPartTypes;
  readonly value: string;
}

export interface Formatters {
  readonly clock: (ms: number) => string;
  readonly day: (ms: number) => string;
  readonly count: (value: number) => string;
  readonly countParts: (value: number) => CountPart[];
  readonly speed: (kmh: number) => string;
}

function createFormatters(locale: Locale): Formatters {
  const tag = LOCALE_TAGS[locale];
  const clock = new Intl.DateTimeFormat(tag, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const day = new Intl.DateTimeFormat(tag, {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "long",
  });
  const count = new Intl.NumberFormat(tag, { useGrouping: "always" });
  const speed = new Intl.NumberFormat(tag, {
    style: "unit",
    unit: "kilometer-per-hour",
    maximumFractionDigits: 0,
  });
  return {
    clock: (ms) => clock.format(ms),
    day: (ms) => day.format(ms).replaceAll(" ", NO_BREAK_SPACE),
    count: (value) => count.format(value),
    countParts: (value) => count.formatToParts(value),
    speed: (kmh) => speed.format(kmh).replaceAll(" ", NO_BREAK_SPACE),
  };
}

const cache = new Map<Locale, Formatters>();

export function formattersFor(locale: Locale): Formatters {
  const cached = cache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const created = createFormatters(locale);
  cache.set(locale, created);
  return created;
}
