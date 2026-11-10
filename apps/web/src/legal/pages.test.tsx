// @vitest-environment happy-dom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVACY_FACTS } from "@gerlines/api/limits";
import { changeLocale } from "@gerlines/i18n";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { localStorageKey } from "../../../../packages/i18n/src/paraglide/runtime.js";
import { CREDITS_PATH } from "../credits/path.ts";
import {
  DEM_TILES_URL,
  GLYPHS_URL,
  SATELLITE_TILES_URL,
  TILES_URL,
} from "../map/style/build-style.ts";
import { ImprintPage } from "./ImprintPage.tsx";
import { licenceName } from "./licence-names.ts";
import { LOCALE_STORAGE_KEY, PrivacyPage } from "./PrivacyPage.tsx";
import { legalPageOf, withLanguage } from "./path.ts";
import { ELEVATION_ROWS, IMAGERY_ROWS } from "./providers.ts";
import { SourcesPage } from "./SourcesPage.tsx";
import { PUBLISHED_MAP_SOURCES, SOURCES } from "./sources.ts";

afterEach(async () => {
  cleanup();
  await changeLocale("en", { persist: false });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const INDEX_HTML = readFileSync(join(HERE, "../../index.html"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const STORAGE_CALL =
  /\b(?:setItem|getItem|removeItem|writePreference|readPreference)\(\s*([^,)]+)|\b(?:write|read)\(\s*storage,\s*([^,)]+)/g;
const OTHER_STORES = /\b(?:sessionStorage|indexedDB|document\.cookie)\b/g;

/**
 * Every storage key the code reads or writes, from string literals, `const NAME = "..."`
 * constants and keys forwarded by a wrapper's own `key: string` parameter. Anything else
 * (template literals, computed keys, other stores) is unknown and fails the test.
 */
type StorageKey = { key: string } | { forwarded: true } | { unknown: string };

function storageKeyOf(arg: string, code: string, constants: Map<string, string>): StorageKey {
  const literal = /^"([^"]+)"$|^'([^']+)'$/.exec(arg)?.slice(1).find(Boolean);
  if (literal) return { key: literal };
  const constant = constants.get(arg);
  if (constant) return { key: constant };
  const declaration = arg.includes(":");
  const parameter = arg === "key" && /\bkey: string\b/.test(code);
  return declaration || parameter ? { forwarded: true } : { unknown: arg };
}

function storageUse(files: readonly { name: string; code: string }[]) {
  const constants = new Map(
    files.flatMap(({ code }) =>
      [...code.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = "([^"]+)"/g)].map(
        (match) => [match[1] ?? "", match[2] ?? ""] as const,
      ),
    ),
  );
  const keys = new Set<string>();
  const unknown: string[] = [];
  for (const { name, code } of files) {
    const odd = [...code.matchAll(OTHER_STORES), ...code.matchAll(/`gerlines[.-][^`]*\$\{/g)];
    unknown.push(...odd.map((match) => `${name}: ${match[0]}`));
    for (const match of code.matchAll(/["'](gerlines[.-][A-Za-z0-9-]+)["']/g))
      keys.add(match[1] ?? "");
    for (const match of code.matchAll(STORAGE_CALL)) {
      const found = storageKeyOf((match[1] ?? match[2] ?? "").trim(), code, constants);
      if ("key" in found) keys.add(found.key);
      if ("unknown" in found) unknown.push(`${name}: storage key ${found.unknown}`);
    }
  }
  return { keys: [...keys], unknown };
}

function hostOf(url: string): string {
  return new URL(url.replace(/\{[^}]+\}/g, "0")).host;
}

function expectedTexts(): string[] {
  const notes = new Set(["perProvider", "perFile"]);
  return [
    ...SOURCES.flatMap((entry) => [
      entry.provider,
      ...entry.licences.map((licence) => licence.name).filter((name) => !notes.has(name)),
      ...(typeof entry.attribution === "string" ? [entry.attribution] : []),
    ]),
    ...[...IMAGERY_ROWS, ...ELEVATION_ROWS].flatMap((row) => [
      row.provider,
      licenceName(row.licence),
    ]),
  ];
}

async function noAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

describe("legal paths", () => {
  it("maps each legal path and ignores others", () => {
    expect(legalPageOf("/sources")).toBe("sources");
    expect(legalPageOf("/sources/")).toBe("sources");
    expect(legalPageOf("/privacy")).toBe("privacy");
    expect(legalPageOf("/impressum")).toBe("imprint");
    expect(legalPageOf("/")).toBeNull();
    expect(legalPageOf(CREDITS_PATH)).toBeNull();
  });
});

describe("language in links", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("carries a known ?lang= and drops anything else", () => {
    expect(withLanguage("/privacy", "?lang=pl&style=dark")).toBe("/privacy?lang=pl");
    expect(withLanguage("/privacy", "?lang=xx")).toBe("/privacy");
    expect(withLanguage("/privacy", "")).toBe("/privacy");
  });

  it("keeps the language of the address on every link between the legal pages and the map", async () => {
    window.history.replaceState(null, "", "/privacy?lang=de");
    await changeLocale("de", { persist: false });
    render(<PrivacyPage />);
    const internal = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/"));
    expect(internal.length).toBeGreaterThanOrEqual(7);
    expect(internal.filter((href) => !href.endsWith("?lang=de"))).toEqual([]);
  });
});

describe("SourcesPage", () => {
  it("shows every source, imagery provider and elevation source with licence or a missing mark", async () => {
    const { container } = render(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sources and licences" })).toBeTruthy();
    const text = container.textContent ?? "";
    expect(expectedTexts().filter((expected) => !text.includes(expected))).toEqual([]);
    const unlicensed = SOURCES.filter((entry) => entry.licences.length === 0);
    const publishedUnlicensed = unlicensed.filter((entry) =>
      PUBLISHED_MAP_SOURCES.includes(entry.id),
    );
    expect(screen.getAllByText("No published licence")).toHaveLength(
      unlicensed.length + publishedUnlicensed.length,
    );
    const uncredited = SOURCES.filter((entry) => entry.attribution === null).length;
    expect(screen.getAllByText("Not stated")).toHaveLength(uncredited);
    expect(screen.getAllByText("Planned, not in use yet").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Per provider, listed below")).toHaveLength(2);
    expect(
      screen
        .getByRole("link", { name: "Per file, listed in the photo credits" })
        .getAttribute("href"),
    ).toBe(CREDITS_PATH);
    expect(text).toContain("Author, licence and file page with every photo");
    expect(text).toContain("© GeoBasis-DE / BKG (2026), changed");
    expect(text).toContain("DELFI e.V., mirrored by traines.eu");
    expect(text).toContain("VersaTiles, orthophotos of the Land survey offices");
    expect(text).not.toContain("&gt;");
    await noAxeViolations(container);
  });

  it("gives the published trains, delays and statistics the licence of each source", () => {
    render(<SourcesPage />);
    const section = screen.getByRole("region", { name: "What we publish and under which licence" });
    const rows = within(section)
      .getAllByRole("listitem")
      .filter((item) => item.parentElement?.closest("li") !== null);
    expect(rows).toHaveLength(PUBLISHED_MAP_SOURCES.length);
    for (const [index, id] of PUBLISHED_MAP_SOURCES.entries()) {
      const entry = SOURCES.find((candidate) => candidate.id === id);
      expect(entry?.status).toBe("used");
      const licences = entry?.licences.map((licence) => licence.name) ?? [];
      expect(rows[index]?.textContent).toBe(
        `${entry?.provider}: ${licences.length > 0 ? licences.join(", ") : "No published licence"}`,
      );
    }
    expect(section.textContent).not.toMatch(/under CC BY-SA 4\.0 and .*ODbL/);
    expect(section.textContent).toContain("Which licence applies where several of these sources");
  });

  it("states that GerLines is not affiliated and links the other legal pages", () => {
    render(<SourcesPage />);
    const notice = screen.getByRole("region", { name: "Not affiliated" });
    expect(notice.textContent).toContain("Deutsche Bahn, DELFI, the Verkehrsverbünde");
    expect(notice.textContent).toContain("who runs a train or provides the data");
    const nav = screen.getByRole("navigation", { name: "Legal pages" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sources",
      CREDITS_PATH,
      "/privacy",
      "/impressum",
    ]);
    expect(
      within(nav).getByRole("link", { name: "Sources and licences" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("opens outside links in a new tab without a referrer and marks licence links", () => {
    render(<SourcesPage />);
    const licence = screen.getAllByRole("link", { name: "DL-DE BY 2.0" })[0];
    expect(licence?.getAttribute("rel")).toBe("license noopener noreferrer");
    expect(licence?.getAttribute("target")).toBe("_blank");
  });

  it("names the licences of the provider tables as the rest of the page does and never breaks a short one", () => {
    const { container } = render(<SourcesPage />);
    const links = [
      ...container.querySelectorAll(
        "[aria-labelledby='imagery-title'] a[rel~='license'], [aria-labelledby='elevation-title'] a[rel~='license']",
      ),
    ];
    expect(links.length).toBeGreaterThan(30);
    const names = links.map((link) => link.textContent ?? "");
    expect(
      names.filter((name) => /DL-DE[^ ]|Datenlizenz|CC-BY|Creative Commons/.test(name)),
    ).toEqual([]);
    expect(names).toContain("DL-DE BY 2.0");
    expect(names).toContain("DL-DE ZERO 2.0");
    expect(names).toContain("CC BY 4.0");
    const unbroken = links.filter((link) => (link.textContent ?? "").length <= 24);
    expect(unbroken.filter((link) => !link.className.includes("whitespace-nowrap"))).toEqual([]);
  });

  it("keeps the hyphen of a credit with the word after it", () => {
    render(<SourcesPage />);
    const bayern = screen.getByText("- www.geodaten.bayern.de");
    expect(bayern.className).toContain("whitespace-nowrap");
    expect(bayern.parentElement?.textContent).toBe(
      "Bayerische Vermessungsverwaltung - www.geodaten.bayern.de",
    );
    expect(screen.getByText("- Bundesamt").className).toContain("whitespace-nowrap");
  });

  it("lays the provider lists out as the source list: the same row, strong provider, regular cells", () => {
    const { container } = render(<SourcesPage />);
    expect(container.querySelector("table")).toBeNull();
    const sourceRow = container.querySelector("[aria-labelledby='group-rail-title'] li");
    expect(sourceRow?.className).toContain("border-hairline");
    expect(sourceRow?.querySelector("dd.type-body-strong")).not.toBeNull();
    for (const id of ["imagery", "elevation"]) {
      const rows = container.querySelectorAll(`[aria-labelledby="${id}-title"] ul > li`);
      expect(rows.length).toBeGreaterThan(20);
      for (const row of rows) {
        expect(row.className).toBe(sourceRow?.className);
        expect(row.querySelector("dd.type-body-strong")).not.toBeNull();
        expect(row.querySelectorAll("dd.type-body").length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("stacks a provider row on a phone with the provider first and labels for area and licence", () => {
    const { container } = render(<SourcesPage />);
    const row = container.querySelector("[aria-labelledby='imagery-title'] ul > li") as HTMLElement;
    const cells = [...row.querySelectorAll("dl > div")];
    expect(cells.map((cell) => /max-lg:order-(\d)/.exec(cell.className)?.[1])).toEqual([
      "2",
      "1",
      "3",
    ]);
    expect(row.querySelector("dt.max-lg\\:w-28")).not.toBeNull();
  });

  it("renders in German and Polish", async () => {
    await changeLocale("de", { persist: false });
    render(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Quellen und Lizenzen" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Impressum" })).toBeTruthy();
    const german = document.body.textContent ?? "";
    expect(german).toContain("© GeoBasis-DE / BKG (2026), geändert");
    expect(german).toContain("DELFI e.V., gespiegelt von traines.eu");
    expect(german).not.toMatch(/, changed|mirrored by/);
    cleanup();
    await changeLocale("pl", { persist: false });
    render(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Źródła i licencje" })).toBeTruthy();
    expect(document.body.textContent).toContain("© GeoBasis-DE / BKG (2026), zmienione");
  });
});

describe("PrivacyPage", () => {
  it("is marked as a draft", async () => {
    const { container } = render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("This privacy policy is a draft");
    expect(screen.getAllByText("Missing").length).toBeGreaterThanOrEqual(2);
    await noAxeViolations(container);
  });

  it("lists exactly the local storage keys the web app uses", () => {
    render(<PrivacyPage />);
    const table = screen.getByRole("table", { name: "Settings in your browser" });
    const keys = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild?.textContent);
    expect(LOCALE_STORAGE_KEY).toBe(localStorageKey);
    const files = sourceFiles(SRC).map((file) => ({
      name: file,
      code: readFileSync(file, "utf8"),
    }));
    const { keys: found, unknown } = storageUse([
      ...files,
      { name: "index.html", code: INDEX_HTML },
    ]);
    expect(unknown).toEqual([]);
    expect([...keys].sort()).toEqual([...new Set([localStorageKey, ...found])].sort());
  });

  it("finds storage keys behind constants and refuses keys it cannot name", () => {
    const use = storageUse([
      {
        name: "known.ts",
        code: [
          'export const A_KEY = "gerlines.a";',
          'localStorage.setItem("gerlines-b", "1");',
          "writePreference(A_KEY, value, storage);",
          "function write(storage: Storage, key: string, value: string) { storage.setItem(key, value); }",
        ].join("\n"),
      },
      {
        name: "unknown.ts",
        code: [
          "sessionStorage.setItem(A_KEY, value);",
          `localStorage.setItem(\`gerlines-\${name}\`, value);`,
          "storage.setItem(OTHER, value);",
          "localStorage.setItem(prefix + name, value);",
        ].join("\n"),
      },
    ]);
    expect(use.keys).toEqual(["gerlines.a", "gerlines-b"]);
    expect(use.unknown).toEqual([
      "unknown.ts: sessionStorage",
      "unknown.ts: `gerlines-${",
      `unknown.ts: storage key \`gerlines-\${name}\``,
      "unknown.ts: storage key OTHER",
      "unknown.ts: storage key prefix + name",
    ]);
  });

  it("states the request limits and the punctuality cache the API keeps", () => {
    render(<PrivacyPage />);
    const server = screen.getByRole("region", { name: "When you open the site" }).textContent ?? "";
    const facts = PRIVACY_FACTS;
    expect(facts.reliabilityHttpCacheMinutes).toBe(5);
    for (const fragment of [
      `${facts.searchPerMinute} per minute for search`,
      `${facts.statsPerMinute} for statistics (${facts.longStatsPerMinute} for long periods)`,
      `${facts.journeysPerMinute} for journeys`,
      `${facts.reliabilityPerMinute} punctuality lookups`,
      `${facts.trainDetailsPerMinute} for train details`,
      `${facts.liveKeysPerMinute} for train lookups on the map`,
      `${facts.statusPerMinute} for the data status`,
      `${facts.photoFilesPerMinute} for vehicle photos`,
      `first 64 bits, by its first 48 bits while the counter table is full, and by its first 32 bits`,
      "an IPv4 address then by its first 16",
      `at most ${facts.sequencePerHour} such lookups per hour, an IPv6 address counted by its first 48 bits`,
      `at most ${facts.reliabilityCacheMinutes} minutes`,
      `at most ${facts.reliabilityCacheEntries.toLocaleString("en")} train numbers`,
      "this answer for five minutes",
    ]) {
      expect(server, fragment).toContain(fragment);
    }
    const retention =
      screen.getByRole("region", { name: "How long data is kept" }).textContent ?? "";
    expect(retention).toContain(
      `Train numbers of punctuality lookups in server memory: at most ${facts.reliabilityCacheMinutes} minutes`,
    );
  });

  it("names every host the browser loads map data from", () => {
    render(<PrivacyPage />);
    const table = screen.getByRole("table", { name: "Map tiles from other hosts" });
    const hosts = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild?.textContent);
    const loaded = new Set([TILES_URL, GLYPHS_URL, SATELLITE_TILES_URL, DEM_TILES_URL].map(hostOf));
    expect(new Set(hosts)).toEqual(loaded);
    const fetched = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      if (file.includes("/legal/") || file.endsWith("Attribution.tsx")) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/https:\/\/[\w.-]+/g)) {
        fetched.add(new URL(match[0]).host);
      }
    }
    expect([...fetched].filter((host) => !loaded.has(host))).toEqual([]);
  });
});

describe("ImprintPage", () => {
  it("shows every required field as missing and invents nothing", async () => {
    const { container } = render(<ImprintPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Impressum" })).toBeTruthy();
    for (const field of ["Name", "Address", "Email", "Phone or other fast contact"]) {
      const term = screen.getByText(field);
      expect(term.nextElementSibling?.textContent).toBe("Missing");
    }
    expect(screen.getAllByText("Missing")).toHaveLength(5);
    expect(container.textContent).not.toMatch(/@|\d{5}/);
    await noAxeViolations(container);
  });

  it("uses the German legal terms", async () => {
    await changeLocale("de", { persist: false });
    render(<ImprintPage />);
    expect(screen.getByText("Angaben gemäß § 5 DDG und § 18 MStV.")).toBeTruthy();
    expect(screen.getByText("Anschrift")).toBeTruthy();
  });
});
