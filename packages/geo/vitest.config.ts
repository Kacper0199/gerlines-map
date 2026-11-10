import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      reportsDirectory: "../../node_modules/.cache/geo-coverage",
      thresholds: { statements: 98, lines: 98, branches: 93 },
    },
  },
});
