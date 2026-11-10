import { describe, expect, it } from "vitest";
import allowList from "../copy-lint.allow.json";
import de from "../messages/de.json";
import en from "../messages/en.json";
import pl from "../messages/pl.json";
import { attributionParts, copyFor, createCopy } from "./copy.ts";
import { createJourneysCopy, journeysCopyFor } from "./copy-journeys.ts";
import { createLegalCopy, legalCopyFor } from "./copy-legal.ts";
import {
  type AllowEntry,
  copyViolations,
  type MessageCatalog,
  renderedExemptions,
} from "./copy-lint.ts";
import { predictCopyFor } from "./copy-predict.ts";
import { profileCopyFor } from "./copy-profile.ts";
import { createStatsCopy, statsCopyFor } from "./copy-stats.ts";
import { statusCopyFor } from "./copy-status.ts";
import { locales } from "./locale.ts";
import { m } from "./paraglide/messages.js";

const CATALOGS: Record<string, MessageCatalog> = { en, de, pl } as unknown as Record<
  string,
  MessageCatalog
>;
const SAMPLE_COUNTS = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 102];

function collectStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (typeof value === "function") {
    for (const sample of SAMPLE_COUNTS) {
      const args = Array.from({ length: value.length }, (_, index) => (index === 0 ? sample : "7"));
      found.push(String(value(...args)));
    }
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, found);
    }
  }
  return found;
}

describe("interface copy for every locale", () => {
  for (const locale of locales) {
    const copy = createCopy(locale);
    const strings = [
      ...collectStrings(copy),
      ...collectStrings(createStatsCopy(locale)),
      ...collectStrings(createLegalCopy(locale)),
      ...collectStrings(createJourneysCopy(locale)),
    ];

    it(`${locale} renders more than 50 strings`, () => {
      expect(strings.length).toBeGreaterThan(50);
    });

    it(`${locale} renders no empty string and no message key`, () => {
      expect(
        strings.filter((text) => text.length === 0 || /^[a-z]+(_[a-z]+)+$/.test(text)),
      ).toEqual([]);
    });

    it("follows copy rule R-15 in every rendered string, with the allow list of the lint", () => {
      const exempt = renderedExemptions(CATALOGS, allowList.allow as AllowEntry[], locale);
      const broken = strings.filter((text) =>
        copyViolations(text).some((rule) => !exempt(rule, text)),
      );
      expect(broken).toEqual([]);
    });
  }
});

describe("lazily loaded copy kept out of the entry copy", () => {
  it("leaves only what the entry reads in the entry copy and the whole block in the page copy", () => {
    for (const locale of locales) {
      const entry = copyFor(locale);
      expect(Object.keys(entry.stats)).toEqual(["open"]);
      expect(Object.keys(entry.journeys)).toEqual(["open"]);
      expect(Object.keys(entry.legal).sort()).toEqual([
        "imprintLink",
        "notAffiliatedShort",
        "privacyLink",
        "sourcesLink",
      ]);
      const stats = statsCopyFor(locale);
      expect(stats.stats.open).toBe(entry.stats.open);
      expect(stats.stats.title.length).toBeGreaterThan(0);
      expect(stats.brand).toBe(entry.brand);
      expect(statsCopyFor(locale)).toBe(stats);
      expect(legalCopyFor(locale).legal.sourcesLink).toBe(entry.legal.sourcesLink);
      expect(legalCopyFor(locale).legal.navLabel.length).toBeGreaterThan(0);
      expect(journeysCopyFor(locale).journeys.open).toBe(entry.journeys.open);
      expect(journeysCopyFor(locale).journeys.title.length).toBeGreaterThan(0);
      expect(Object.keys(entry)).not.toContain("predict");
      const predict = predictCopyFor(locale);
      expect(predict.predict.title.length).toBeGreaterThan(0);
      expect(predict.delay.minutes).toBe(entry.delay.minutes);
      expect(predictCopyFor(locale)).toBe(predict);
      expect(Object.keys(entry)).not.toContain("profile");
      const profile = profileCopyFor(locale);
      expect(profile.profile.title.length).toBeGreaterThan(0);
      expect(profile.delay.minutes).toBe(entry.delay.minutes);
      expect(profileCopyFor(locale)).toBe(profile);
      expect(Object.keys(entry)).not.toContain("status");
      const status = statusCopyFor(locale);
      expect(status.status.title.length).toBeGreaterThan(0);
      expect(status.live.live).toBe(entry.live.live);
      expect(statusCopyFor(locale)).toBe(status);
    }
  });
});

describe("copy functions", () => {
  it("fills the parameters in every language", () => {
    expect(createCopy("en").card.platformChanged("7", "5")).toBe("Platform 7, was 5");
    expect(createCopy("de").card.platformChanged("7", "5")).toBe("Gleis 7 statt 5");
    expect(createCopy("pl").card.platformChanged("7", "5")).toBe("Peron 7 zamiast 5");
    expect(createCopy("de").card.dataFrom("21:35", "25. Oktober")).toBe(
      "Stand 21:35, 25. Oktober.",
    );
  });

  it("puts the count inside the untracked message, grouped like the other counts", () => {
    const en = createCopy("en").legend;
    expect(en.untracked(1)).toBe("1 train without track geometry is not shown");
    expect(en.untracked(2665)).toBe("2,665 trains without track geometry are not shown");
    const de = createCopy("de").legend;
    expect(de.untracked(1)).toBe("1 Zug ohne Gleisgeometrie wird nicht angezeigt");
    expect(de.untracked(2665)).toBe("2.665 Züge ohne Gleisgeometrie werden nicht angezeigt");
    const pl = createCopy("pl").legend;
    expect(pl.untracked(1)).toBe("Nie pokazano 1 pociągu bez geometrii toru");
    expect(pl.untracked(37)).toBe("Nie pokazano 37 pociągów bez geometrii toru");
    expect(pl.untracked(2665).replace(/\s/g, " ")).toBe(
      "Nie pokazano 2 665 pociągów bez geometrii toru",
    );
  });

  it("names the high-speed legend row as a product list in German and Polish, a short row that never hyphenates", () => {
    expect(createCopy("de").categories.hsr.legend).toBe("ICE, TGV, RJX");
    expect(createCopy("pl").categories.hsr.legend).toBe("ICE, TGV, RJX");
  });

  it("carries the shell copy in every language", () => {
    expect(createCopy("en").soon.tag).toBe("Soon");
    expect(createCopy("de").soon.tag).toBe("Demnächst");
    expect(createCopy("pl").soon.tag).toBe("Wkrótce");
    expect(createCopy("de").style.satellite).toBe("Satellit");
    expect(createCopy("pl").search.placeholder).toBe("Wyszukaj pociąg, linię lub stację");
    expect(createCopy("de").attribution.show).toBe("Datenquellen anzeigen");
  });

  it("has a short search placeholder for narrow phones, at most 70 percent of the characters of the full one, a stand-in for its width", () => {
    expect(createCopy("en").search.placeholderShort).toBe("Train or station");
    expect(createCopy("de").search.placeholderShort).toBe("Zug, Linie, Bahnhof");
    expect(createCopy("pl").search.placeholderShort).toBe("Pociąg lub stacja");
    for (const locale of locales) {
      const { placeholder, placeholderShort } = createCopy(locale).search;
      expect(placeholderShort.length).toBeLessThan(placeholder.length * 0.7);
    }
  });

  it("words the page title and description in every language, with the product name first", () => {
    for (const locale of locales) {
      const { brand } = createCopy(locale);
      expect(brand.title.startsWith(`${brand.name}, `)).toBe(true);
      expect(brand.description.length).toBeGreaterThan(20);
    }
    expect(createCopy("de").brand.title).toBe("GerLines, Live-Karte aller Züge in Deutschland");
  });

  it("words the map error with a title, a reason to act on and a reload button", () => {
    for (const locale of locales) {
      const { error } = createCopy(locale).map;
      expect(error.title.length).toBeGreaterThan(10);
      expect(error.body).toContain("WebGL");
      expect(error.reload.length).toBeGreaterThan(5);
    }
    expect(createCopy("pl").map.error.title).toBe("Nie udało się wczytać mapy");
  });

  it("switches to the short message for one minute or less", () => {
    for (const locale of locales) {
      const card = createCopy(locale).card;
      expect(card.toNextStop(1)).not.toContain("1");
      expect(card.toNextStop(7)).toContain("7");
    }
  });

  it("joins the holders of a data source in the words of each language", () => {
    expect(attributionParts("DELFI e.V. and GTFS.de")).toEqual({
      holders: ["DELFI e.V.", "GTFS.de"],
      mirror: null,
    });
    expect(attributionParts("DELFI e.V., mirrored by traines.eu")).toEqual({
      holders: ["DELFI e.V."],
      mirror: "traines.eu",
    });
    expect(createCopy("en").train.attribution("DELFI e.V. and GTFS.de")).toBe(
      "DELFI e.V. and GTFS.de",
    );
    expect(createCopy("de").train.attribution("DELFI e.V. and GTFS.de")).toBe(
      "DELFI e.V. und GTFS.de",
    );
    expect(createCopy("pl").train.attribution("DELFI e.V. and GTFS.de")).toBe(
      "DELFI e.V. i GTFS.de",
    );
    expect(createCopy("de").train.attribution("DELFI e.V., mirrored by traines.eu")).toBe(
      "DELFI e.V., gespiegelt von traines.eu",
    );
    expect(createCopy("pl").train.attribution("DELFI e.V.")).toBe("DELFI e.V.");
  });

  it("words the card for short runs, later days and the destination", () => {
    expect(createCopy("en").train.endsEarly(4, "Günzburg")).toBe(
      "Ends at Günzburg, 4 stops cancelled",
    );
    expect(createCopy("de").train.endsEarly(1, "Günzburg")).toBe(
      "Endet in Günzburg, 1 Halt entfällt",
    );
    expect(createCopy("pl").train.endsEarly(5, "Günzburg")).toBe(
      "Kończy bieg: Günzburg, 5 postojów odwołanych",
    );
    expect(createCopy("pl").train.stopsCancelled(2)).toBe("2 postoje odwołane");
    expect(createCopy("en").train.dayLater(1)).toBe("next day");
    expect(createCopy("pl").train.to("Homburg (Saar) Hbf")).toBe("Kierunek Homburg (Saar) Hbf");
    expect(createCopy("pl").train.follow).toBe("Śledź");
  });

  it("returns one cached copy per locale so that consumers can depend on it", () => {
    for (const locale of locales) {
      expect(copyFor(locale)).toBe(copyFor(locale));
    }
    expect(copyFor("de")).not.toBe(copyFor("pl"));
  });

  it("types the parameters of a compiled message", () => {
    const wrongCall = () => {
      // @ts-expect-error the platform message needs the track
      return m.card_platform({}, { locale: "en" });
    };
    const wrongLocale = () => {
      // @ts-expect-error French is not a project locale
      return m.card_platform({ track: "7" }, { locale: "fr" });
    };
    expect(wrongCall).toBeTypeOf("function");
    expect(wrongLocale).toBeTypeOf("function");
  });
});

describe("profile copy of legs under another station id", () => {
  it("counts the legs with the plural forms of each language", () => {
    expect(profileCopyFor("en").profile.idsDiffer(1)).toContain("1 segment of this route is");
    expect(profileCopyFor("de").profile.idsDiffer(2)).toContain("2 Abschnitte");
    expect(profileCopyFor("pl").profile.idsDiffer(1)).toContain("1 odcinek");
    expect(profileCopyFor("pl").profile.idsDiffer(3)).toContain("3 odcinki");
    expect(profileCopyFor("pl").profile.idsDiffer(5)).toContain("5 odcinków");
  });
});

describe("data status copy", () => {
  it("names the live state in the trigger and fills times and limits in every language", () => {
    expect(copyFor("en").live.openStatus("Live")).toBe("Live. Show the data sources");
    expect(copyFor("pl").live.openStatus("Na żywo")).toBe("Na żywo. Pokaż źródła danych");
    expect(statusCopyFor("de").status.recorded("12:03")).toBe("Aufgezeichnet 12:03");
    expect(statusCopyFor("en").status.live.age(4)).toBe("Last update 4 s ago");
    expect(statusCopyFor("pl").status.note(5, 20)).toContain("od 5 do 20 minut");
    expect(statusCopyFor("de").status.state.stale).toBe(copyFor("de").live.stale);
    for (const locale of locales) {
      const copy = statusCopyFor(locale).status;
      expect(Object.keys(copy.country).sort()).toEqual(["BE", "CH", "CZ", "DE", "FR", "NL", "PL"]);
      expect(Object.keys(copy.state)).toEqual(["ok", "stale", "down", "not_recorded"]);
    }
  });

  it("explains every state in the note with the words of its label", () => {
    for (const locale of locales) {
      const copy = statusCopyFor(locale).status;
      const note = copy.note(5, 20);
      for (const label of Object.values(copy.state)) expect(note).toContain(`${label} `);
    }
  });
});
