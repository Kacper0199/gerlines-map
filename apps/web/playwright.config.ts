import { defineConfig } from "@playwright/test";
import { VIEWPORTS } from "./e2e/support/viewports.ts";

const PORT = Number(process.env.E2E_PORT ?? 8818);
const CI = Boolean(process.env.CI);
const LOCAL_BASELINES = Boolean(process.env.E2E_LOCAL_BASELINES);
const SLOWER = CI ? 4 : 1;
const SOFTWARE_GL = Boolean(process.env.E2E_SOFTWARE_GL);
const GL_ARGS = SOFTWARE_GL ? ["--use-gl=angle", "--use-angle=swiftshader"] : [];

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/test-results",
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}-{platform}{ext}",
  timeout: 60_000 * SLOWER,
  expect: {
    timeout: 15_000 * SLOWER,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.004,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
    },
  },
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? (CI ? 1 : 2)),
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  updateSnapshots: CI ? "none" : "missing",
  ignoreSnapshots: process.platform === "darwin" && !LOCAL_BASELINES,
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "./e2e/report" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--proxy-server=127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", ...GL_ARGS],
    },
  },
  projects: VIEWPORTS.map((viewport) => ({
    name: viewport.name,
    testMatch: viewport.specs.map((spec) => `**/${spec}.spec.ts`),
    use: {
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.touch,
      hasTouch: viewport.touch,
      deviceScaleFactor: 1,
    },
  })),
  webServer: {
    command: "node e2e/server/fixture-server.ts",
    url: `http://127.0.0.1:${PORT}/__e2e/info`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
