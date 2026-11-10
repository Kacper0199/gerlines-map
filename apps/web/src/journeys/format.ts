import { LOCALE_TAGS, type Locale } from "@gerlines/i18n";
import type { JourneysCopy as JourneysBlock } from "@gerlines/i18n/journeys";
import { durationParts } from "./journey-view.ts";

export type JourneysCopy = JourneysBlock;

const shares = new Map<Locale, Intl.NumberFormat>();

/** A share as a whole percent in the locale's way (83 %, 83%). */
export function formatShare(locale: Locale, share: number): string {
  let format = shares.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: "percent",
      maximumFractionDigits: 0,
    });
    shares.set(locale, format);
  }
  return format.format(share);
}

export function formatDuration(copy: JourneysCopy, seconds: number): string {
  const { hours, minutes } = durationParts(seconds);
  if (hours === 0) return copy.durationM(minutes);
  return minutes === 0 ? copy.durationH(hours) : copy.durationHm(hours, minutes);
}

const days = new Map<Locale, Intl.DateTimeFormat>();

/** A service day (YYYY-MM-DD) as a short date in the locale's way (27 Oct, 27. Okt., 27 paź). */
export function formatDay(locale: Locale, day: string): string {
  let format = days.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    days.set(locale, format);
  }
  return format.format(new Date(`${day}T00:00:00Z`));
}

export function formatChanges(copy: JourneysCopy, transfers: number): string {
  return transfers === 0 ? copy.direct : copy.changes(transfers);
}
