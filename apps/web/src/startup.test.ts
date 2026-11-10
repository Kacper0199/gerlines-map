// @vitest-environment happy-dom
import { changeLocale, currentLocale } from "@gerlines/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStartupPreferences } from "./startup.ts";
import { storeTheme } from "./theme/preference.ts";

const LOCALE_KEY = "PARAGLIDE_LOCALE";
const THEME_KEY = "gerlines-theme";

beforeEach(async () => {
  window.localStorage.clear();
  await changeLocale("en", { persist: false });
});
afterEach(async () => {
  window.localStorage.clear();
  await changeLocale("en", { persist: false });
});

describe("applyStartupPreferences", () => {
  it("applies a language from the address for this visit without storing it", async () => {
    const theme = await applyStartupPreferences("?lang=pl", window.localStorage);

    expect(currentLocale()).toBe("pl");
    expect(document.documentElement.lang).toBe("pl-PL");
    expect(window.localStorage.getItem(LOCALE_KEY)).toBeNull();
    expect(theme).toBe("dark");
  });

  it("applies a theme from the address for this visit without storing it", async () => {
    const theme = await applyStartupPreferences("?theme=light", window.localStorage);

    expect(theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("lets the address win over the stored theme but leaves the stored value alone", async () => {
    storeTheme(window.localStorage, "light");

    const theme = await applyStartupPreferences("?theme=dark", window.localStorage);

    expect(theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("starts in the map style the address asks for", async () => {
    expect(await applyStartupPreferences("?style=terrain", window.localStorage)).toBe("terrain");
  });

  it("ignores a language that the product does not have", async () => {
    await applyStartupPreferences("?lang=fr", window.localStorage);

    expect(currentLocale()).toBe("en");
  });

  it("still stores a language the visitor picks with the switch", async () => {
    await applyStartupPreferences("?lang=pl", window.localStorage);

    await changeLocale("de");

    expect(window.localStorage.getItem(LOCALE_KEY)).toBe("de");
  });
});
