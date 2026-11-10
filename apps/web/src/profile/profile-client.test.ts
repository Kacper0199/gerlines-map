import { describe, expect, it, vi } from "vitest";
import answer from "./fixtures/segments-619-hsr.json" with { type: "json" };
import { fetchProfile, profileUrl } from "./profile-client.ts";

const SUBJECT = { number: "619", category: "hsr", operatorId: "db-fernverkehr-ag" } as const;
const RANGE = { from: "2026-09-28", to: "2026-10-27" };

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("profileUrl", () => {
  it("asks the segments of the train number for the card category, operator and period", () => {
    expect(profileUrl(SUBJECT, RANGE)).toBe(
      "/api/v1/stats/trains/619/segments?from=2026-09-28&to=2026-10-27&category=hsr&operator=db-fernverkehr-ag",
    );
  });

  it("leaves the operator out when the card has none or its id is not one the API accepts", () => {
    expect(profileUrl({ ...SUBJECT, operatorId: null }, RANGE)).not.toContain("operator");
    expect(profileUrl({ ...SUBJECT, operatorId: "DB Regio AG" }, RANGE)).not.toContain("operator");
  });

  it("encodes the train number", () => {
    expect(profileUrl({ ...SUBJECT, number: "RB 1" }, RANGE)).toContain("/trains/RB%201/segments");
  });
});

describe("fetchProfile", () => {
  it("parses the answer with the API schema", async () => {
    const fetch = vi.fn(async () => reply(200, answer));
    const result = await fetchProfile(SUBJECT, RANGE, { fetch });
    expect(result.kind === "ok" && result.data.segments).toHaveLength(22);
  });

  it("names what failed and passes on the wait the server asked for", async () => {
    const limited = await fetchProfile(SUBJECT, RANGE, {
      fetch: async () => reply(429, { error: "rate_limited" }, { "retry-after": "7" }),
    });
    expect(limited).toEqual({ kind: "rate-limited", retryAfterS: 7 });
    const none = await fetchProfile(SUBJECT, RANGE, { fetch: async () => reply(503, {}) });
    expect(none.kind).toBe("unavailable");
    const down = await fetchProfile(SUBJECT, RANGE, {
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(down.kind).toBe("unreachable");
    const odd = await fetchProfile(SUBJECT, RANGE, {
      fetch: async () => reply(200, { kind: "x" }),
    });
    expect(odd.kind).toBe("unreadable");
  });
});
