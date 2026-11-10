import { describe, expect, it } from "vitest";
import { feedMismatch } from "./shapes-database.ts";

describe("feedMismatch", () => {
  const main = [
    { feedVersionId: 1, sha256: "a".repeat(64) },
    { feedVersionId: 2, sha256: "b".repeat(64) },
  ];

  it("accepts a shapes database that links the same feeds under the same ids", () => {
    expect(feedMismatch(main, [{ feedVersionId: 1, sha256: "a".repeat(64) }])).toBeNull();
  });

  it("refuses another feed under the same id, or an id the main database lacks", () => {
    expect(feedMismatch(main, [{ feedVersionId: 1, sha256: "b".repeat(64) }])).toMatch(
      /feed version 1 is another feed/,
    );
    expect(feedMismatch(main, [{ feedVersionId: 3, sha256: "c".repeat(64) }])).toMatch(
      /feed version 3 is not in the main database/,
    );
  });
});
