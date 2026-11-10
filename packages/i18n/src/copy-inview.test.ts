import { describe, expect, it } from "vitest";
import { a11yCopyFor } from "./copy-a11y.ts";
import { COMPASS_POINTS, inViewCopyFor } from "./copy-inview.ts";
import { locales } from "./locale.ts";

describe("trains in view copy", () => {
  it("has every string in every locale", () => {
    for (const locale of locales) {
      const copy = inViewCopyFor(locale);
      for (const text of [
        copy.title,
        copy.open,
        copy.close,
        copy.hint,
        copy.empty,
        copy.loading,
        copy.update,
        copy.failed,
      ]) {
        expect(text.length).toBeGreaterThan(0);
      }
      for (const point of COMPASS_POINTS) expect(copy.directions[point].length).toBeGreaterThan(0);
      expect(copy.kilometres("2,3")).toContain("2,3");
      expect(copy.metres("450")).toContain("450");
      expect(inViewCopyFor(locale)).toBe(copy);
    }
  });

  it("names the eight directions apart", () => {
    for (const locale of locales) {
      const names = COMPASS_POINTS.map((point) => inViewCopyFor(locale).directions[point]);
      expect(new Set(names).size).toBe(8);
    }
  });

  it("counts trains in view with the plural of each language", () => {
    expect(a11yCopyFor("en").viewSummary(1)).toBe("1 train in view");
    expect(a11yCopyFor("en").viewSummary(412)).toBe("412 trains in view");
    expect(a11yCopyFor("en").viewSummary(0)).toBe("No trains in view");
    expect(a11yCopyFor("de").viewSummary(1)).toBe("1 Zug im Ausschnitt");
    expect(a11yCopyFor("de").viewSummary(3)).toBe("3 Züge im Ausschnitt");
    expect(a11yCopyFor("pl").viewSummary(1)).toBe("1 pociąg w widoku");
    expect(a11yCopyFor("pl").viewSummary(3)).toBe("3 pociągi w widoku");
    expect(a11yCopyFor("pl").viewSummary(412)).toBe("412 pociągów w widoku");
  });

  it("has the new accessibility strings in every locale", () => {
    for (const locale of locales) {
      const copy = a11yCopyFor(locale);
      for (const text of [copy.skipToInView, copy.shortcuts, copy.shortcutsHint, copy.sourceList]) {
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});
