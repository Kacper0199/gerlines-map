import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_SOURCES, fontsCss, KEPT_SUBSETS, parseFontsourceFaces } from "./fonts-css.ts";

const generated = readFileSync(new URL("../styles/fonts.generated.css", import.meta.url), "utf8");

function readWeight(packageName: string, weight: number): string {
  return readFileSync(
    new URL(`../../node_modules/@fontsource/${packageName}/${weight}.css`, import.meta.url),
    "utf8",
  );
}

describe("fonts.generated.css", () => {
  it("is what the generator produces from the installed Fontsource packages", () => {
    expect(generated).toBe(fontsCss(readWeight));
  });

  it("declares Overpass 400, 600 and 800 and Overpass Mono 400 and 600 in two subsets each", () => {
    const faces = generated.match(/@font-face/g)?.length;
    const expected = FONT_SOURCES.reduce(
      (sum, source) => sum + source.weights.length * KEPT_SUBSETS.length,
      0,
    );
    expect(faces).toBe(expected);
    expect(expected).toBe(10);
  });

  it("gives every face a unicode range and swap display so the subsets do not shadow each other", () => {
    const blocks = generated.split("@font-face").slice(1);
    for (const block of blocks) {
      expect(block).toContain("unicode-range: U+");
      expect(block).toContain("font-display: swap;");
      expect(block).toContain(".woff2");
    }
  });

  it("covers the Polish diacritics through the latin ext range", () => {
    const faces = parseFontsourceFaces(readWeight("overpass", 400), "overpass");
    const latinExt = faces.find((face) => face.subset === "latin-ext");
    const covered = (codePoint: number) =>
      (latinExt?.unicodeRange ?? "").split(",").some((range) => {
        const [from, to] = range.replace("U+", "").split("-");
        const start = Number.parseInt(from ?? "", 16);
        const end = Number.parseInt(to ?? from ?? "", 16);
        return codePoint >= start && codePoint <= end;
      });
    for (const letter of ["ł", "ń", "ś", "ź", "ż", "ą", "ę", "ć"]) {
      expect(covered(letter.codePointAt(0) ?? 0), letter).toBe(true);
    }
  });
});
