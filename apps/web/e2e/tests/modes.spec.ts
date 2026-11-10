import type { Page } from "@playwright/test";
import { FIXTURE } from "../support/fixture.ts";
import { expect, test } from "../support/test.ts";

const COLOURS = {
  ok: [0x7c, 0xc9, 0xb4],
  reg: [0x5f, 0x97, 0xde],
  severe: [0xe8, 0x6b, 0xd0],
} as const;
type Counts = Record<keyof typeof COLOURS, number>;

async function count(page: Page): Promise<Counts> {
  const png = (
    await page.screenshot({ clip: { x: 420, y: 60, width: 760, height: 780 } })
  ).toString("base64");
  return page.evaluate(
    async ([data, colours]) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${data}`)).blob(),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const result: Record<string, number> = Object.fromEntries(
        Object.keys(colours).map((name) => [name, 0]),
      );
      for (let i = 0; i < pixels.length; i += 4) {
        for (const [name, [r, g, b]] of Object.entries(colours)) {
          const near = (value: number, wanted: number) => Math.abs(value - wanted) < 6;
          if (
            near(pixels[i] as number, r as number) &&
            near(pixels[i + 1] as number, g as number) &&
            near(pixels[i + 2] as number, b as number)
          ) {
            result[name] = (result[name] as number) + 1;
          }
        }
      }
      return result;
    },
    [png, COLOURS] as const,
  ) as Promise<Counts>;
}

test("colour modes recolour the trains, the legend follows, the toggles hide trains, the mode survives a reload", async ({
  app,
  page,
}) => {
  test.slow();
  await app.open({ style: "dark" });
  await app.view(FIXTURE.city.lon, FIXTURE.city.lat, 11.5);
  const colours = page.getByRole("radiogroup", { name: "Train colours" });
  const legend = page.getByRole("region", { name: "Trains on the map" });

  const category = await count(page);
  test.info().annotations.push({ type: "category pixels", description: JSON.stringify(category) });
  expect(category.reg).toBeGreaterThan(20);
  expect(category.ok + category.severe).toBeLessThan(5);
  await expect(page.getByTestId("delay-legend")).toHaveCount(0);

  await colours.getByRole("radio", { name: "Delay" }).click({ force: true });
  await expect(page.getByTestId("delay-legend")).toBeVisible();
  await expect.poll(async () => (await count(page)).ok).toBeGreaterThan(20);
  const delay = await count(page);
  test.info().annotations.push({ type: "delay pixels", description: JSON.stringify(delay) });
  expect(delay.severe).toBeGreaterThan(3);
  expect(delay.reg).toBeLessThan(5);

  const rows = page.getByTestId("delay-legend").getByRole("listitem");
  await expect(rows).toHaveCount(6);
  const sum = await rows.evaluateAll((items) =>
    items.reduce(
      (total, item) =>
        total + Number((item.lastElementChild?.textContent ?? "").replace(/[^0-9]/g, "")),
      0,
    ),
  );
  const stated = Number(
    (((await legend.textContent()) ?? "").match(/([0-9,]+) total/) as RegExpMatchArray)[1]?.replace(
      /,/g,
      "",
    ),
  );
  expect(sum).toBe(stated);
  expect(stated).toBe(FIXTURE.trainCount);

  await page.getByTestId("label-mode").getByRole("radio", { name: "Line" }).click({ force: true });
  await expect(page.getByText("Zoom in to show the labels")).toBeHidden();
  await page.getByTestId("label-mode").getByRole("radio", { name: "Off" }).click({ force: true });

  await page.reload();
  await expect(colours.getByRole("radio", { name: "Delay" })).toBeChecked();
  await app.settle();
  await page.getByRole("button", { name: "Show on the map" }).click();

  const names = [
    "ICE and high speed",
    "IC, EC, FLX",
    "Night trains",
    "RE, IRE, MEX",
    "RB",
    "S-Bahn",
    "Foreign trains",
  ];
  for (const name of names) await page.getByRole("checkbox", { name }).click();
  await expect(page.getByRole("checkbox", { name: "S-Bahn" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect
    .poll(async () => (await count(page)).ok + (await count(page)).severe)
    .toBeLessThan(6);
  for (const name of names) await page.getByRole("checkbox", { name }).click();
  await expect.poll(async () => (await count(page)).ok).toBeGreaterThan(20);

  await colours.getByRole("radio", { name: "Category" }).click({ force: true });
  await expect.poll(async () => (await count(page)).reg).toBeGreaterThan(20);
});
