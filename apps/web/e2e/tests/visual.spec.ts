import { fileURLToPath } from "node:url";
import { FIXTURE } from "../support/fixture.ts";
import { expect, test } from "../support/test.ts";

const HIDE_MAP = fileURLToPath(new URL("../support/hide-map.css", import.meta.url));
const REQUIRED_CHROME = ["search-card", "live-bar"];
const OPTIONAL_CHROME = ["legend-card", "style-picker", "layers-button", "colour-key"];

test.describe("map shots (loose: software GL varies)", () => {
  test.use({ leanMap: false });

  test("national overview, dark, English", async ({ app, page }) => {
    await app.open({ style: "dark", lang: "en" });
    await expect(page).toHaveScreenshot("overview-dark-en.webp");
  });

  test("Frankfurt, light, German", async ({ app, page }) => {
    await app.open({ style: "light", lang: "de" });
    await app.view(FIXTURE.city.lon, FIXTURE.city.lat, 12);
    await expect(page).toHaveScreenshot("frankfurt-light-de.webp");
  });
});

test.describe("chrome shots (map hidden, tight: a card restyle must fail)", () => {
  for (const [style, lang] of [
    ["dark", "en"],
    ["light", "de"],
  ] as const) {
    test(`the cards and bars, ${style}, ${lang}`, async ({ app, page }) => {
      await app.open({ style, lang });
      for (const slot of REQUIRED_CHROME) {
        await expect(page.locator(`[data-slot=${slot}]`), `${slot} is on the page`).toBeVisible();
      }
      for (const slot of [...REQUIRED_CHROME, ...OPTIONAL_CHROME]) {
        const card = page.locator(`[data-slot=${slot}]`);
        if ((await card.count()) === 0) continue;
        await expect(card).toHaveScreenshot(`chrome-${slot}-${style}-${lang}.webp`, {
          stylePath: HIDE_MAP,
          threshold: 0.05,
          maxDiffPixels: 50,
        });
      }
    });
  }
});
