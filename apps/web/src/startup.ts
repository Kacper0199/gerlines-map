import { applyDocumentLanguage, changeLocale, isLocale } from "@gerlines/i18n";
import type { MapStyleKind } from "./map/style/map-styles.ts";
import { initialMapStyle } from "./theme/preference.ts";

export async function applyStartupPreferences(
  search: string,
  storage: Pick<Storage, "getItem">,
): Promise<MapStyleKind> {
  const language = new URLSearchParams(search).get("lang");
  if (language !== null && isLocale(language)) {
    await changeLocale(language, { persist: false });
  }
  applyDocumentLanguage();
  return initialMapStyle(search, storage);
}
