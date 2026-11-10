import { FIXTURE } from "../support/fixture.ts";
import { expect, test } from "../support/test.ts";

const KEY = FIXTURE.detailedKeys.regional;

function dwelling() {
  const train = FIXTURE.trips.find((entry) => entry.key === KEY);
  if (!train?.dwelling) throw new Error(`train ${KEY} does not dwell at the fixture time`);
  return { train, ...train.dwelling };
}

test("a click selects a train, Escape, the empty map and Close deselect it, Back selects it again", async ({
  app,
  page,
}) => {
  const { train, lon, lat } = dwelling();
  await app.open();
  await app.view(lon, lat, 14);
  const at = await app.project(lon, lat);
  const card = page.getByText(`Train ${train.trainNumber}`);

  await page.mouse.click(at.x, at.y);
  await expect(card).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("train")).not.toBeNull();

  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("train")).toBeNull();

  await app.view(lon, lat, 14);
  const again = await app.project(lon, lat);
  await page.mouse.click(again.x, again.y);
  await expect(card).toBeVisible();

  await page.mouse.click(again.x, again.y - 150);
  await expect(card).toBeHidden();

  await app.view(lon, lat, 14);
  const third = await app.project(lon, lat);
  await page.mouse.click(third.x, third.y);
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect(card).toBeHidden();

  await page.goBack();
  await expect(card).toBeVisible();
});
