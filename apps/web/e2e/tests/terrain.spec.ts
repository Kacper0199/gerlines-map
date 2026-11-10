import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.ts";

/** The style card folds into one row on a compact or short window; its thumbnails and switches then sit in a popover. */
async function openStyleCard(page: Page): Promise<void> {
  const fold = page.getByTestId("style-fold");
  if ((await fold.count()) > 0 && (await fold.getAttribute("aria-expanded")) !== "true") {
    await fold.click();
  }
}

// Motion on, as in the stack script: with reduced motion the switch-off leaves the pitch limit at 60 (see W93.md, finding F-1).
test.use({ reducedMotion: "no-preference" });

test("the 3D terrain and building switches live in the Terrain style and tilt the map", async ({
  app,
  page,
}) => {
  test.slow();
  const warnings: string[] = [];
  page.on("console", (message) => message.type() === "warning" && warnings.push(message.text()));
  await app.open({ style: "dark" });
  await page.evaluate(() => {
    localStorage.removeItem("gerlines-terrain-3d");
    localStorage.removeItem("gerlines-buildings-3d");
  });
  await page.reload();
  await app.settle();

  await openStyleCard(page);
  await expect(page.getByRole("switch", { name: "3D terrain" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "3D buildings" })).toHaveCount(0);

  await openStyleCard(page);
  await page.getByRole("button", { name: "Terrain", exact: true }).click();
  const terrain = page.getByRole("switch", { name: "3D terrain" });
  await openStyleCard(page);
  await expect(terrain).toBeVisible();
  if ((await terrain.getAttribute("aria-checked")) === "true") await terrain.click();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        maxPitch: window.gerlinesMap?.getMaxPitch(),
        terrain: Boolean(window.gerlinesMap?.getTerrain()),
      })),
    )
    .toEqual({ maxPitch: 0, terrain: false });

  await openStyleCard(page);
  await terrain.click();
  await expect
    .poll(() => page.evaluate(() => window.gerlinesMap?.getPitch() ?? 0))
    .toBeGreaterThan(40);
  const on = await page.evaluate(() => ({
    max: window.gerlinesMap?.getMaxPitch(),
    exaggeration: window.gerlinesMap?.getTerrain()?.exaggeration,
  }));
  expect(on).toEqual({ max: 60, exaggeration: 1.5 });
  expect(await page.evaluate(() => localStorage.getItem("gerlines-terrain-3d"))).toBe("on");

  await openStyleCard(page);
  const buildings = page.getByRole("switch", { name: "3D buildings" });
  await expect(buildings).toBeVisible();
  if ((await buildings.getAttribute("aria-checked")) !== "true") await buildings.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const layer = window.gerlinesMap?.getLayer("building_3d");
        return layer && { type: layer.type, minzoom: layer.minzoom };
      }),
    )
    .toEqual({ type: "fill-extrusion", minzoom: 14.5 });

  await openStyleCard(page);
  await terrain.click();
  await expect
    .poll(() => page.evaluate(() => window.gerlinesMap?.getPitch() ?? 99))
    .toBeLessThan(1);
  await expect(page.getByRole("switch", { name: "3D buildings" })).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(window.gerlinesMap?.getLayer("building_3d")))).toBe(
    false,
  );
  expect(warnings.filter((text) => /style diff/i.test(text))).toEqual([]);
});
