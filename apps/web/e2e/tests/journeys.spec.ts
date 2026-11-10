import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.ts";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../src/journeys/fixtures/${name}.json`, import.meta.url), "utf8"),
  );

const first = fixture("journeys-bremen-hamburg");
const later = fixture("journeys-bremen-hamburg-later");
const reliability = fixture("reliability-bremen-hamburg");

// Test doubles, not recordings: the station records (made-up ids) and the earlier page (the first page moved
// two hours back); the journeys and the reliability answer are recorded fixtures of src/journeys.
const station = (id: string, name: string, dhid: string, lon: number, lat: number) => ({
  kind: "station",
  id,
  name,
  lon,
  lat,
  eva: null,
  dhid,
  stopId: dhid,
  lines: [],
  trainsToday: 0,
});
const STATIONS = [
  station(
    "11111111-1111-4111-8111-111111111111",
    "Bremen Hbf",
    "de:04011:13927",
    8.81418,
    53.083501,
  ),
  station(
    "22222222-2222-4222-8222-222222222222",
    "Hamburg Hbf",
    "de:02000:10950",
    10.006909,
    53.552736,
  ),
];

const TWO_HOURS_MS = 7_200_000;
const ISO_SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function earlierPage(): unknown {
  return JSON.parse(
    JSON.stringify(first, (key, value) => {
      if (typeof value === "string" && ISO_SECONDS.test(value)) {
        return new Date(Date.parse(value) - TWO_HOURS_MS).toISOString().replace(".000Z", "Z");
      }
      if (key === "id" && typeof value === "string" && /^[0-9a-f]{16}$/.test(value))
        return `e${value.slice(1)}`;
      return value;
    }),
  );
}

async function mockRouter(page: Page): Promise<void> {
  const earlier = earlierPage();
  await page.route(/\/api\/v1\/search\?/, (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const results = STATIONS.filter((item) =>
      item.name.toLowerCase().startsWith(q.slice(0, 4).toLowerCase()),
    );
    return route.fulfill({
      json: { query: q, serviceDate: "2026-11-10", timetableVersion: "fixture", results },
    });
  });
  await page.route(/\/api\/v1\/stations\//, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const found = STATIONS.find((item) => item.id === id);
    return found
      ? route.fulfill({ json: found })
      : route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route(/\/api\/v1\/journeys\/reliability/, (route) =>
    route.fulfill({ json: reliability }),
  );
  await page.route(/\/api\/v1\/journeys\?/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor") ?? "";
    const answer = cursor.startsWith("LATER")
      ? later
      : cursor.startsWith("EARLIER")
        ? earlier
        : first;
    return route.fulfill({ json: answer });
  });
}

const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test("plan, pick, page, switch to statistics and back, reload, history and a link", async ({
  app,
  page,
}) => {
  app.tolerate(/\/api\/v1\/stats/);
  await page.route(/\/api\/v1\/stats/, (route) =>
    route.fulfill({ status: 503, json: { error: "stats_unavailable" } }),
  );
  await mockRouter(page);
  await app.open();

  await page.getByRole("button", { name: "Plan a journey" }).click();
  const panel = page.getByRole("article", { name: "Journey planner" });
  await expect(panel).toBeVisible();

  const pick = async (label: string, text: string, option: RegExp) => {
    await page.getByRole("combobox", { name: label }).fill(text);
    await page.getByRole("option", { name: option }).first().click();
  };
  await pick("From", "Bremen Hbf", /Bremen Hbf/);
  await pick("To", "Hamburg Hbf", /Hamburg Hbf/);
  await page.getByLabel("Date and time").fill("2026-11-10T07:00");
  await page.getByRole("button", { name: "Find journeys" }).click();

  const rows = page.locator("[data-slot=journey-row]");
  await expect(rows.first()).toBeVisible();
  const firstCount = await rows.count();
  expect(firstCount).toBeGreaterThanOrEqual(3);
  await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => param(page, "jsel")).not.toBeNull();
  expect(decodeURIComponent(page.url())).toMatch(/jfrom=.*jto=.*jtime=2026-11-10T07/);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = window.gerlinesMap;
        if (!(map?.getLayer("gl-journey-line") && map.getLayer("gl-journey-stops"))) return 0;
        return map
          .querySourceFeatures("gl-journey")
          .filter((feature) => feature.geometry.type === "LineString")
          .reduce(
            (total, feature) => total + (feature.geometry as GeoJSON.LineString).coordinates.length,
            0,
          );
      }),
    )
    .toBeGreaterThan(10);

  const hint = page.locator("[data-slot=journey-reliability]").first();
  await expect(hint).not.toContainText("Loading");
  const hintText = (await hint.textContent()) ?? "";
  expect(hintText).toMatch(
    /on time since|too few to rate|No recorded|not available|Several operators|No train number/,
  );
  const runs = Number(hintText.match(/(\d+) recorded run/)?.[1] ?? Number.NaN);
  if (runs < 5) expect(hintText).not.toMatch(/%/);

  const historyBefore = await page.evaluate(() => history.length);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  const selectedAfterPick = param(page, "jsel");

  const firstDeparture = (await rows.first().locator(".num").first().textContent()) ?? "";
  await page.getByRole("button", { name: "Later journeys" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(firstCount);
  const afterLater = await rows.count();
  await page.getByRole("button", { name: "Earlier journeys" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(afterLater);
  const earliest = (await rows.first().locator(".num").first().textContent()) ?? "";
  expect(earliest < firstDeparture).toBe(true);
  expect(param(page, "jsel")).toBe(selectedAfterPick);

  const stats = page.getByRole("button", { name: "Statistics" });
  await stats.click();
  await expect(page.getByRole("article", { name: "Statistics" })).toBeVisible();
  await expect(page.locator("[data-slot=planner-panel]")).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.gerlinesMap?.getLayer("gl-journey-line")))).toBe(
    false,
  );
  expect(param(page, "plan")).toBeNull();
  expect(param(page, "jfrom") && param(page, "jto") && param(page, "jsel")).toBeTruthy();

  const reopenPlanner = async () => {
    await page.getByRole("button", { name: "Plan a journey" }).click();
    await expect(panel).toBeVisible();
    await expect(rows.first()).toBeVisible();
    await expect(page.locator("article[aria-label=Statistics]")).toHaveCount(0);
    await expect(page.locator("[data-slot=planner-panel] [role=combobox]").first()).toHaveValue(
      "Bremen Hbf",
    );
    await expect(page.locator("[data-slot=journey-row][aria-pressed=true]")).toHaveCount(1);
    await expect.poll(() => param(page, "jsel")).toBe(selectedAfterPick);
    expect(param(page, "plan")).toBe("1");
    await expect
      .poll(() => page.evaluate(() => Boolean(window.gerlinesMap?.getLayer("gl-journey-line"))))
      .toBe(true);
  };
  await reopenPlanner();

  await stats.click();
  await expect(page.getByRole("article", { name: "Statistics" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Plan a journey" })).toBeVisible();
  expect(param(page, "plan")).toBeNull();
  expect(param(page, "jsel")).toBe(selectedAfterPick);
  await reopenPlanner();

  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expect(page.locator("[data-slot=journey-row][aria-pressed=true]")).toHaveCount(1);
  expect(param(page, "plan")).toBe("1");

  const link = page.url();
  for (let step = 0; step < 12 && param(page, "jfrom"); step += 1) {
    const before = page.url();
    await page.goBack();
    await expect.poll(() => page.url()).not.toBe(before);
  }
  await expect.poll(() => page.url().includes("jfrom=")).toBe(false);
  await expect(rows).toHaveCount(0);

  await page.goto(link);
  await expect(rows.first()).toBeVisible();
  await expect(page.locator("[data-slot=journey-row][aria-pressed=true]")).toHaveCount(1);
  expect(param(page, "jsel")).toBe(selectedAfterPick);

  await page.getByRole("button", { name: "Close journey planner" }).click();
  await expect.poll(() => page.url().includes("plan=1")).toBe(false);
  expect(await page.evaluate(() => Boolean(window.gerlinesMap?.getLayer("gl-journey-line")))).toBe(
    false,
  );
});
