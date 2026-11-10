import { LOCALE_TAGS } from "@gerlines/i18n";
import { useLocale } from "@gerlines/i18n/react";
import { useCallback, useMemo } from "react";

/** Berlin wall-clock time with seconds in the page's language; the same function until the language changes. */
export function useClockWithSeconds(): (seconds: number) => string {
  const locale = useLocale();
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    [locale],
  );
  return useCallback((seconds) => formatter.format(seconds * 1000), [formatter]);
}
