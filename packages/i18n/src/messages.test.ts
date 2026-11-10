import { describe, expect, it } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import pl from "../messages/pl.json";
import { CATEGORY_KEYS, ERROR_CODES } from "./copy.ts";
import { locales } from "./locale.ts";
import * as compiled from "./paraglide/messages.js";

interface Variant {
  readonly declarations: readonly string[];
  readonly selectors: readonly string[];
  readonly match: Readonly<Record<string, string>>;
}

type Entry = string | readonly Variant[];
type Catalog = Readonly<Record<string, Entry | undefined>>;

const catalogs: Readonly<Record<(typeof locales)[number], Catalog>> = { en, de, pl };

const SAME_AS_ENGLISH_ALLOWED = new Set([
  "brand_name",
  "map_zoom_group",
  "live_live",
  "delay_minutes",
  "journeys_duration_m",
  "category_ld_legend",
  "category_rfast_legend",
  "category_reg_legend",
  "category_sbahn_legend",
  "category_sbahn_badge",
  "colour_key_hsr",
  "colour_key_ld",
  "colour_key_rfast",
  "colour_key_reg",
  "colour_key_sbahn",
  "card_badge_bus",
  "attribution_open_free_map",
  "attribution_open_map_tiles",
  "search_train_route",
  "attribution_natural_earth",
  "attribution_delfi",
  "attribution_gtfs_de",
  "attribution_db_stada",
  "legal_imprint_link",
  "legal_imprint_title",
  "legal_imprint_name",
  "legal_column_status",
  "legal_privacy_hosting_title",
  "profile_measure_median",
  "inview_km",
  "inview_m",
]);

function entries(catalog: Catalog): [string, Entry][] {
  return Object.entries(catalog).filter(
    (pair): pair is [string, Entry] => !pair[0].startsWith("$") && pair[1] !== undefined,
  );
}

function leaves(entry: Entry): string[] {
  return typeof entry === "string" ? [entry] : entry.flatMap((v) => Object.values(v.match));
}

function placeholders(entry: Entry): string[] {
  const found = new Set<string>();
  for (const text of leaves(entry)) {
    for (const hit of text.matchAll(/\{(\w+)\}/g)) {
      found.add(hit[1] ?? "");
    }
  }
  return [...found].sort();
}

function pluralCategories(entry: Entry): string[] {
  if (typeof entry === "string") {
    return [];
  }
  return entry.flatMap((v) => Object.keys(v.match).map((key) => key.split("=")[1] ?? ""));
}

describe("messages carry no invisible characters", () => {
  it.each(Object.entries(catalogs))("%s has no soft hyphens", (_, catalog) => {
    expect(JSON.stringify(catalog)).not.toContain("\u00ad");
  });
});

describe("message catalogs", () => {
  const base = Object.fromEntries(entries(en));

  it("compiles one message function per English message", () => {
    const functions = Object.keys(compiled).filter((name) => name !== "m" && !name.startsWith("_"));
    expect(functions.sort()).toEqual(Object.keys(base).sort());
  });

  it.each(["de", "pl"] as const)("%s has exactly the keys of English", (locale) => {
    expect(
      entries(catalogs[locale])
        .map(([key]) => key)
        .sort(),
    ).toEqual(Object.keys(base).sort());
  });

  it.each(["de", "pl"] as const)("%s uses the same placeholders as English", (locale) => {
    const mismatches = entries(catalogs[locale])
      .filter(([key, entry]) => {
        const source = base[key];
        return source === undefined || placeholders(entry).join() !== placeholders(source).join();
      })
      .map(([key]) => key);
    expect(mismatches).toEqual([]);
  });

  it.each(["de", "pl"] as const)("%s translates every message that is not a name", (locale) => {
    const untranslated = entries(catalogs[locale])
      .filter(([key, entry]) => {
        const source = base[key];
        return (
          source !== undefined &&
          !SAME_AS_ENGLISH_ALLOWED.has(key) &&
          leaves(entry).join("|") === leaves(source).join("|")
        );
      })
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it("gives plural messages the categories of each language", () => {
    const required: Record<(typeof locales)[number], string[]> = {
      en: ["one", "other"],
      de: ["one", "other"],
      pl: ["few", "many", "one", "other"],
    };
    for (const locale of locales) {
      const plurals = entries(catalogs[locale]).filter(([, entry]) => typeof entry !== "string");
      expect(plurals.length).toBeGreaterThan(0);
      for (const [, entry] of plurals) {
        expect(pluralCategories(entry).sort()).toEqual(required[locale]);
      }
    }
  });

  it("words every error code and every category in every language", () => {
    for (const locale of locales) {
      const keys = new Set(entries(catalogs[locale]).map(([key]) => key));
      for (const code of ERROR_CODES) {
        expect(keys.has(`live_error_${code}`)).toBe(true);
      }
      for (const category of CATEGORY_KEYS) {
        expect(keys.has(`category_${category}_legend`)).toBe(true);
        expect(keys.has(`category_${category}_badge`)).toBe(true);
      }
    }
  });

  it("keeps the German and Polish special characters intact", () => {
    const german = entries(de)
      .flatMap(([, entry]) => leaves(entry))
      .join("");
    const polish = entries(pl)
      .flatMap(([, entry]) => leaves(entry))
      .join("");
    expect(german).toMatch(/[äöüß]/);
    expect(polish).toMatch(/[ąćęłńóśźż]/);
  });
});
