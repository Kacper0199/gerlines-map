import { expect, test } from "../support/test.ts";

const CATEGORY = { en: "Category", de: "Kategorie", pl: "Kategoria" } as const;

for (const lang of ["en", "de", "pl"] as const) {
  test(`the ${lang} page is in ${lang}, fits the window and the map fills it`, async ({
    app,
    page,
  }) => {
    await app.open({ lang });
    const size = page.viewportSize();
    const layout = await page.evaluate(() => {
      const canvas = window.gerlinesMap?.getCanvas().getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        canvas: canvas && { width: canvas.width, height: canvas.height },
        lang: document.documentElement.lang,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.canvas?.width).toBeGreaterThanOrEqual((size?.width ?? 0) - 1);
    expect(layout.canvas?.height).toBeGreaterThanOrEqual((size?.height ?? 0) - 1);
    expect(layout.lang.startsWith(lang)).toBe(true);
    await expect(page.getByRole("radio", { name: CATEGORY[lang] })).toBeAttached();
  });
}

test("Tab reaches the search field", async ({ app, page }) => {
  await app.open();
  const search = page.getByRole("combobox").first();
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    if (await search.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(search).toBeFocused();
});
