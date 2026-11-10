import { fileURLToPath } from "node:url";
import { test as base, type ConsoleMessage, expect, type Page } from "@playwright/test";
import { FIXTURE } from "./fixture.ts";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url)).replace(/\/$/, "");
const READY_MS = process.env.CI ? 120_000 : 30_000;
const TEST_HEADER = "x-e2e-test";
const BASEMAP_TILE = /\/basemap\/tiles\/[^/]+\/[^/]+\/[^/]+\.pbf$/;
const NATIONAL_SHAPES = /\/geo\/germany-(mask|outline)\.geojson$/;
const NO_FEATURES = JSON.stringify({ type: "FeatureCollection", features: [] });

const OPENFREEMAP = "tiles.openfreemap.org";
const WITHOUT_FIXTURE = new Set(["tiles.mapterhorn.com", "tiles.versatiles.org"]);

export interface OpenOptions {
  readonly lang?: "en" | "de" | "pl";
  readonly style?: "dark" | "light" | "satellite" | "terrain";
  readonly query?: Record<string, string>;
  readonly waitForTrains?: boolean;
}

export interface App {
  readonly page: Page;
  readonly errors: string[];
  readonly blocked: string[];
  /** A console error caused by a request whose address matches is not a failure (a test that mocks a failing API). */
  tolerate(address: RegExp): void;
  open(options?: OpenOptions): Promise<void>;
  settle(): Promise<void>;
  view(lon: number, lat: number, zoom: number): Promise<void>;
  project(lon: number, lat: number): Promise<{ x: number; y: number }>;
}

function replayAddress(options: OpenOptions): string {
  const params = new URLSearchParams({
    probe: "1",
    replay: "0.0001",
    tier: "high",
    lang: options.lang ?? "en",
    style: options.style ?? "dark",
    ...options.query,
  });
  return `/?${params.toString()}`;
}

function isTolerated(message: ConsoleMessage, tolerated: readonly RegExp[]): boolean {
  const url = message.location().url;
  if (!url) return false;
  return (
    WITHOUT_FIXTURE.has(new URL(url).hostname) || tolerated.some((pattern) => pattern.test(url))
  );
}

/**
 * Under software GL (the CI runner) every frame of the full basemap costs seconds, and the page redraws all the time.
 * A lean map answers the vector tiles with empty ones and the national mask and outline with no features, which
 * measured about three times the frame rate at 1440x900 (7 to 23 frames per second, M1 Pro, SwiftShader), so the
 * flows do not wait on rendering. Only the map shots, which compare the basemap itself, turn it off.
 */
export const test = base.extend<{ app: App; leanMap: boolean }>({
  leanMap: [!process.env.E2E_FULL_MAP, { option: true }],
  app: async ({ page, context, baseURL, leanMap }, use, testInfo) => {
    const origin = new URL(baseURL as string).origin;
    const errors: string[] = [];
    const blocked: string[] = [];
    const tolerated: RegExp[] = [];
    const sockets: string[] = [];
    await context.setExtraHTTPHeaders({ [TEST_HEADER]: testInfo.testId });

    await context.route(
      (url) => url.origin !== origin,
      async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === OPENFREEMAP) {
          const path =
            url.pathname === "/planet"
              ? "/basemap/tiles.json"
              : url.pathname.replace(/^\/fonts/, "/basemap/fonts");
          const response = await route.fetch({
            url: `${origin}${path}`,
            headers: { [TEST_HEADER]: testInfo.testId },
          });
          await route.fulfill({ response });
          return;
        }
        if (WITHOUT_FIXTURE.has(url.hostname)) {
          await route.fulfill({ status: 404, body: "" });
          return;
        }
        blocked.push(url.href);
        await route.abort();
      },
    );

    if (leanMap) {
      await context.route(BASEMAP_TILE, (route) => route.fulfill({ status: 200, body: "" }));
      await context.route(NATIONAL_SHAPES, (route) =>
        route.fulfill({ status: 200, contentType: "application/geo+json", body: NO_FEATURES }),
      );
    }
    await context.routeWebSocket(/.*/, (socket) => {
      sockets.push(socket.url());
      void socket.close();
    });
    const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 1);
    if (throttle > 1) {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await page.clock.setFixedTime(FIXTURE.frozenAt);
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" && !isTolerated(message, tolerated))
        errors.push(`${message.text()} ${message.location().url}`);
    });

    const app: App = {
      page,
      errors,
      blocked,
      tolerate(address) {
        tolerated.push(address);
      },
      async open(options = {}) {
        await page.goto(replayAddress(options));
        if (options.waitForTrains !== false) await app.settle();
      },
      async view(lon, lat, zoom) {
        await page.evaluate(
          (target) =>
            window.gerlinesMap?.jumpTo({
              center: [target.lon, target.lat],
              zoom: target.zoom,
              pitch: 0,
              bearing: 0,
            }),
          { lon, lat, zoom },
        );
        await page.waitForFunction(
          () => {
            const map = window.gerlinesMap;
            return map !== undefined && !map.isMoving() && map.areTilesLoaded();
          },
          null,
          { timeout: READY_MS },
        );
      },
      async project(lon, lat) {
        return page.evaluate(
          ([x, y]) => {
            const point = window.gerlinesMap?.project([x as number, y as number]);
            return { x: point?.x ?? Number.NaN, y: point?.y ?? Number.NaN };
          },
          [lon, lat],
        );
      },
      async settle() {
        await page.waitForFunction(() => window.gerlinesMap?.loaded() === true, null, {
          timeout: READY_MS,
        });
        // A compact window opens the credits and collapses them after five real seconds. The button toggles, so a
        // click that lands after the timer would reopen them: close them in one page task, never by a click that waits
        // for a slow frame.
        await page.locator("aside > button[aria-controls]").evaluateAll((buttons) =>
          buttons.forEach((button) => {
            if (button.getAttribute("aria-expanded") === "true") (button as HTMLElement).click();
          }),
        );
        await expect(page.locator("aside > button[aria-controls][aria-expanded=true]")).toHaveCount(
          0,
        );
        await expect
          .poll(
            () =>
              page.evaluate(async () => (await window.gerlinesLive?.diagnostics())?.trains ?? 0),
            { timeout: READY_MS },
          )
          .toBe(FIXTURE.trainCount);
        await page.waitForFunction(
          () => {
            const map = window.gerlinesMap;
            return map !== undefined && !map.isMoving() && map.areTilesLoaded();
          },
          null,
          { timeout: READY_MS },
        );
      },
    };
    const info = await (await page.request.get(`${origin}/__e2e/info`)).json();
    expect(info.dist, "the fixture server on this port serves this checkout's build").toBe(DIST);
    await use(app);
    const unmatched = await (
      await page.request.get(
        `${origin}/__e2e/unmatched?test=${encodeURIComponent(testInfo.testId)}`,
      )
    ).json();
    expect(unmatched, "requests the fixture server has no answer for").toEqual([]);
    const tiles = await (
      await page.request.get(
        `${origin}/__e2e/unmatched?kind=tile&test=${encodeURIComponent(testInfo.testId)}`,
      )
    ).json();
    if (tiles.length > 0) {
      testInfo.annotations.push({
        type: "basemap tiles outside the extract",
        description: `${tiles.length}`,
      });
    }
    expect(sockets, "WebSockets the page opened").toEqual([]);
    expect(blocked, "requests to hosts outside the fixture").toEqual([]);
    expect(errors, "console and page errors").toEqual([]);
  },
});

export { expect };

declare global {
  interface Window {
    gerlinesMap?: import("maplibre-gl").Map;
    gerlinesLive?: { diagnostics(): Promise<{ trains: number; ticks: number }> };
  }
}
