import { m } from "./paraglide/messages.js";
import {
  baseLocale,
  getLocale,
  isLocale,
  type Locale,
  locales,
  setLocale,
} from "./paraglide/runtime.js";

export type { Locale };
export { baseLocale, isLocale, locales };

export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  de: "Deutsch",
  pl: "Polski",
};

export const LOCALE_TAGS: Readonly<Record<Locale, string>> = {
  en: "en-GB",
  de: "de-DE",
  pl: "pl-PL",
};

type Listener = () => void;

const listeners = new Set<Listener>();
let active: Locale = detectLocale();

function detectLocale(): Locale {
  try {
    return getLocale();
  } catch {
    return baseLocale;
  }
}

export function currentLocale(): Locale {
  return active;
}

export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ChangeLocaleOptions {
  readonly persist?: boolean;
}

export async function changeLocale(
  next: Locale,
  { persist = true }: ChangeLocaleOptions = {},
): Promise<void> {
  if (next === active) {
    return;
  }
  active = next;
  applyDocument(next);
  const persisted = persist ? persistLocale(next) : Promise.resolve();
  const failures = notifyListeners();
  await persisted;
  if (failures.length > 0) {
    throw new AggregateError(failures, "A locale listener threw");
  }
}

function notifyListeners(): unknown[] {
  const failures: unknown[] = [];
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function persistLocale(next: Locale): Promise<void> {
  try {
    await setLocale(next, { reload: false });
  } catch {
    return;
  }
}

function applyDocument(locale: Locale): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = LOCALE_TAGS[locale];
  document.title = m.brand_title({}, { locale });
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", m.brand_description({}, { locale }));
}

export function applyDocumentLanguage(): void {
  applyDocument(active);
}
