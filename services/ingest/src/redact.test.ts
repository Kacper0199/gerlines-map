import { describe, expect, it } from "vitest";
import { redactText, redactUrl } from "./redact.ts";

describe("redactUrl", () => {
  it("removes userinfo", () => {
    expect(redactUrl("https://user:pw@example.org/feed.pb", [])).toBe(
      "https://example.org/feed.pb",
    );
  });

  it("redacts key-like query parameters and keeps the others", () => {
    expect(
      redactUrl("https://example.org/feed?apiKey=abc123&format=pb&access_token=t0k3n", []),
    ).toBe("https://example.org/feed?apiKey=redacted&format=pb&access_token=redacted");
  });

  it("redacts a known secret in the path", () => {
    const token = "c0ffee00c0ffee00c0ffee00c0ffee00";
    expect(redactUrl(`https://rt.example.org/gtfs/realtime/${token}`, [token])).toBe(
      "https://rt.example.org/gtfs/realtime/redacted",
    );
  });

  it("returns a placeholder for a value that is not a URL", () => {
    expect(redactUrl("not a url", [])).toBe("invalid-url");
  });
});

describe("redactText", () => {
  it("replaces every configured secret and ignores empty and short ones", () => {
    expect(redactText("Bearer s3cr3tvalue failed for s3cr3tvalue", ["s3cr3tvalue", "", "ab"])).toBe(
      "Bearer redacted failed for redacted",
    );
  });
});
