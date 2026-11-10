import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("component class names", () => {
  const folders = ["ui", "patterns", "domain"].map(
    (name) => new URL(`./${name}/`, import.meta.url),
  );
  const sources = folders.flatMap((folder) =>
    readdirSync(folder)
      .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
      .map((file) => ({ file, text: readFileSync(new URL(file, folder), "utf8") })),
  );

  it("never selects on a data attribute that Base UI does not set", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/data-(horizontal|vertical):/);
    }
  });

  it("uses no colour from the default Tailwind palette", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\b(bg|text|border|fill|stroke)-(black|white)\b/);
    }
  });
});
