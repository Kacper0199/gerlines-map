import { isLocale } from "@gerlines/i18n";

export const SOURCES_PATH = "/sources";
export const PRIVACY_PATH = "/privacy";
export const IMPRINT_PATH = "/impressum";

export type LegalPage = "sources" | "privacy" | "imprint";

const PAGES: Readonly<Record<string, LegalPage>> = {
  [SOURCES_PATH]: "sources",
  [PRIVACY_PATH]: "privacy",
  [IMPRINT_PATH]: "imprint",
};

export function legalPageOf(pathname: string): LegalPage | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGES[trimmed] ?? null;
}

/** The path with the `?lang=` of the current address when it names a locale, since that choice is not stored. */
export function withLanguage(path: string, search = globalThis.location?.search ?? ""): string {
  const language = new URLSearchParams(search).get("lang");
  return language !== null && isLocale(language) ? `${path}?lang=${language}` : path;
}
