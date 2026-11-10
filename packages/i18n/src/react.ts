import { useSyncExternalStore } from "react";
import { type Copy, copyFor } from "./copy.ts";
import { type Formatters, formattersFor } from "./format.ts";
import { baseLocale, currentLocale, type Locale, subscribeLocale } from "./locale.ts";

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, currentLocale, () => baseLocale);
}

export function useCopy(): Copy {
  return copyFor(useLocale());
}

export function useFormatters(): Formatters {
  return formattersFor(useLocale());
}
