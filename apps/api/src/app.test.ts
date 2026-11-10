import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

function silentLogger() {
  const lines: string[] = [];
  return { lines, error: (line: string) => void lines.push(line) };
}

describe("security headers", () => {
  it("sends nosniff, a same-origin resource policy and no frame embedding on every answer", async () => {
    const response = await createApp({ logger: silentLogger() }).request("/api/health");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });
});

describe("health route", () => {
  it("answers ok", async () => {
    const response = await createApp({ logger: silentLogger() }).request("/api/health");

    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("development routes", () => {
  it("are gone: the old trips proxy answers 404", async () => {
    const app = createApp({ logger: silentLogger() });

    expect((await app.request("/api/dev/transitous/trips")).status).toBe(404);
  });
});
