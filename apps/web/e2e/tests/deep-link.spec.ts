import { FIXTURE } from "../support/fixture.ts";
import { expect, test } from "../support/test.ts";

const TRAIN = FIXTURE.tripInstanceIds.regional;

test("a train link opens its card and keeps its address", async ({ app, page }) => {
  await app.open({ query: { train: TRAIN } });
  const card = page.getByRole("article").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("24349");
  // a negative check: the card must not close by itself, so it needs a wait rather than a signal
  await page.waitForTimeout(1500);
  await expect(card).toBeVisible();
  expect(page.url()).toContain(`train=${TRAIN}`);
});

test("a Land from the search takes the focus, Back and Forward restore the entries", async ({
  app,
  page,
}) => {
  await app.open({ query: { train: TRAIN } });
  const card = page.getByRole("article").first();
  await expect(card).toBeVisible();

  const field = page.getByRole("combobox", { name: "Search" });
  await field.fill("Bayern");
  await page
    .getByRole("option", { name: /Bavaria/ })
    .first()
    .click();
  const chip = page.getByRole("button", { name: /not only Bavaria/ });
  await expect(chip).toBeVisible();
  expect(page.url()).toContain("land=DE-BY");

  await page.goBack();
  await expect(chip).toHaveCount(0);
  await page.goForward();
  await expect(chip).toBeVisible();
});

test("a station link that fails keeps its address and offers Try again, a missing one says so", async ({
  app,
  page,
}) => {
  const failing = "00000000-0000-4000-8000-0000000000f1";
  const unknown = "00000000-0000-4000-8000-0000000000f2";
  app.tolerate(/\/api\/v1\/stations\//);
  await page.route(`**/api/v1/stations/${failing}`, (route) =>
    route.fulfill({ status: 503, json: { error: "search_unavailable" } }),
  );
  await page.route(`**/api/v1/stations/${unknown}`, (route) =>
    route.fulfill({ status: 404, json: { error: "not_found" } }),
  );
  await app.open();
  await page.goto(`/?lang=en&probe=1&replay=0.0001&station=${failing}`);
  await expect(page.getByText("Station details are not available right now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(page.url()).toContain(`station=${failing}`);

  await page.goto(`/?lang=en&probe=1&replay=0.0001&station=${unknown}`);
  await expect(page.getByRole("heading", { name: "Station not found" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("station")).toBe(false);
});
