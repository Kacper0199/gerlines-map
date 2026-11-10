import { LOCALE_TAGS, type Locale } from "@gerlines/i18n";

const numberFormats = new Map<string, Intl.NumberFormat>();

export function numberFormat(locale: Locale, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: "always",
    });
    numberFormats.set(key, format);
  }
  return format;
}

const wholePercents = new Map<Locale, Intl.NumberFormat>();

/** A share as a whole percent for axis ticks. */
export function percentTick(share: number, locale: Locale): string {
  let format = wholePercents.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: "percent",
      maximumFractionDigits: 0,
    });
    wholePercents.set(locale, format);
  }
  return format.format(share);
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

export function dayFormat(locale: Locale, style: "full" | "short"): Intl.DateTimeFormat {
  const key = `${locale}|${style}`;
  let format = dayFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(
      LOCALE_TAGS[locale],
      style === "full"
        ? { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }
        : { timeZone: "UTC", day: "numeric", month: "short" },
    );
    dayFormats.set(key, format);
  }
  return format;
}

/** A service day (YYYY-MM-DD) in the reader's language; days carry no time zone. */
export function formatDay(day: string, locale: Locale, style: "full" | "short" = "full"): string {
  return dayFormat(locale, style).format(Date.parse(`${day}T00:00:00Z`));
}

export function formatMonth(year: number, month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(Date.UTC(year, month - 1, 1));
}
