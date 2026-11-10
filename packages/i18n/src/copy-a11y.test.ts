import { describe, expect, it } from "vitest";
import { a11yCopyFor } from "./copy-a11y.ts";
import { locales } from "./locale.ts";

describe("accessibility copy", () => {
  it("has every string in every locale", () => {
    for (const locale of locales) {
      const copy = a11yCopyFor(locale);
      expect(copy.skipToSearch.length).toBeGreaterThan(0);
      expect(copy.mapKeys.length).toBeGreaterThan(0);
      expect(copy.retryKey.length).toBeGreaterThan(0);
      expect(a11yCopyFor(locale)).toBe(copy);
    }
  });

  it("counts results with the plural of each language", () => {
    expect(a11yCopyFor("en").results(1)).toBe("1 result");
    expect(a11yCopyFor("en").results(5)).toBe("5 results");
    expect(a11yCopyFor("de").results(1)).toBe("1 Ergebnis");
    expect(a11yCopyFor("de").results(3)).toBe("3 Ergebnisse");
    expect(a11yCopyFor("pl").results(1)).toBe("1 wynik");
    expect(a11yCopyFor("pl").results(3)).toBe("3 wyniki");
    expect(a11yCopyFor("pl").results(5)).toBe("5 wyników");
  });
});
