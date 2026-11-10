import { describe, expect, it } from "vitest";
import { signatureCopyFor } from "./copy-signature.ts";
import { locales } from "./locale.ts";

describe("signature copy", () => {
  it("has the tilt switch label in every locale", () => {
    for (const locale of locales) {
      const copy = signatureCopyFor(locale);
      expect(copy.tilt.length).toBeGreaterThan(0);
      expect(copy.privacyStorage.length).toBeGreaterThan(0);
      expect(signatureCopyFor(locale)).toBe(copy);
    }
  });
});
