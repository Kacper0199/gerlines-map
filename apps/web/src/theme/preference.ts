import type { ThemeName } from "@gerlines/ui/tokens";
import { isMapStyle, type MapStyleKind, themeForStyle } from "../map/style/map-styles.ts";

export const THEME_STORAGE_KEY = "gerlines-theme";
export const MAP_STYLE_STORAGE_KEY = "gerlines-map-style";

function asTheme(value: string | null | undefined): ThemeName | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

function asStyle(value: string | null | undefined): MapStyleKind | undefined {
  return isMapStyle(value) ? value : undefined;
}

export function themeFromSearch(search: string): ThemeName | undefined {
  return asTheme(new URLSearchParams(search).get("theme"));
}

export function styleFromSearch(search: string): MapStyleKind | undefined {
  return asStyle(new URLSearchParams(search).get("style"));
}

function read(storage: Pick<Storage, "getItem">, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function readStoredTheme(storage: Pick<Storage, "getItem">): ThemeName | undefined {
  return asTheme(read(storage, THEME_STORAGE_KEY));
}

export function readStoredStyle(storage: Pick<Storage, "getItem">): MapStyleKind | undefined {
  return asStyle(read(storage, MAP_STYLE_STORAGE_KEY));
}

function write(storage: Pick<Storage, "setItem">, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    return;
  }
}

export function storeTheme(storage: Pick<Storage, "setItem">, theme: ThemeName): void {
  write(storage, THEME_STORAGE_KEY, theme);
}

export function storeMapStyle(storage: Pick<Storage, "setItem">, style: MapStyleKind): void {
  write(storage, MAP_STYLE_STORAGE_KEY, style);
  write(storage, THEME_STORAGE_KEY, themeForStyle(style));
}

export function initialMapStyle(search: string, storage: Pick<Storage, "getItem">): MapStyleKind {
  return (
    styleFromSearch(search) ??
    themeFromSearch(search) ??
    readStoredStyle(storage) ??
    readStoredTheme(storage) ??
    "dark"
  );
}

export function initialTheme(search: string, storage: Pick<Storage, "getItem">): ThemeName {
  return themeForStyle(initialMapStyle(search, storage));
}
