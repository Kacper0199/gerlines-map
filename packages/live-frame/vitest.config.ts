import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      reportsDirectory: "../../node_modules/.cache/live-frame-coverage",
      thresholds: { statements: 97, lines: 97, branches: 92 },
    },
  },
});
