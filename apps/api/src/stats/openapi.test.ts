import { describe, expect, it } from "vitest";
import { statsOpenApiPaths } from "./openapi.ts";

describe("statistics OpenAPI descriptions", () => {
  it("credit the backfilled history to piebro under CC BY 4.0 with data from Deutsche Bahn", () => {
    const descriptions = Object.values(statsOpenApiPaths()).map((item) => item.get.description);
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description).toContain("collected and processed by piebro");
      expect(description).toContain("https://github.com/piebro/deutsche-bahn-data");
      expect(description).toContain("CC BY 4.0");
      expect(description).toContain("data from Deutsche Bahn");
    }
  });
});
