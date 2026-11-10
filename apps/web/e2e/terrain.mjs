#!/usr/bin/env node
// End-to-end check of WP-5.3 against a live engine: the 3D terrain switch (hidden outside the Terrain style, tilts the
// map and sets MapLibre terrain, comes back off), the 3D buildings switch (only while the relief is on; adds the
// extrusion layer from zoom 14.5 and leaves with the relief), a real mouse click on a train drawn on the relief
// selecting it (the train comes from the frames through window.gerlinesLive.trainsNear, is centred, and the mouse clicks around the view centre, 700 ms apart (the wait between tries is what fixed the S4 misses; double-click zoom is switched off only as a precaution), until the relief-lifted train answers, so no pixel search or attribution box can fool it), the trains still moving after four zooms across zoom 12 (the deck line is cleared and sent again each time), and no style diff warning from MapLibre at load or on a switch. Failed /api/ requests are ignored: it needs
// only the live engine, not the API. Writes a playwright-cli run-code script.
// Usage: node e2e/terrain.mjs <base url> <out.js>, then
//   playwright-cli -s=<session> run-code --filename=<out.js>
import { writeFileSync } from "node:fs";

const [base, out] = process.argv.slice(2);
if (!(base && out)) {
  process.stderr.write("usage: node e2e/terrain.mjs <base url> <out.js>\n");
  process.exit(2);
}

const code = `async (page) => {
  const base = ${JSON.stringify(base.replace(/\/+$/, ""))};
  const checks = [];
  const check = (name, ok, seen) => checks.push({ name, ok: Boolean(ok), seen });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && !/\\/api\\//.test(message.location().url) && errors.push(message.text()));
  const warnings = [];
  page.on("console", (message) => message.type() === "warning" && warnings.push(message.text()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "/?replay=1&probe=1&lang=en&style=dark");
  await page.evaluate(() => { localStorage.removeItem("gerlines-terrain-3d"); localStorage.removeItem("gerlines-buildings-3d"); });
  await page.reload();
  await page.waitForFunction(() => window.gerlinesMap && window.gerlinesMap.loaded(), null, { timeout: 40000 });
  await page.waitForFunction(() => /total/.test(document.querySelector("[data-slot=legend-card]")?.textContent ?? ""), null, { timeout: 40000 });

  const openStyleCard = async () => {
    const fold = page.getByTestId("style-fold");
    if ((await fold.count()) > 0 && (await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  };
  await openStyleCard();
  check("no 3D terrain switch outside the Terrain style", (await page.getByRole("switch", { name: "3D terrain" }).count()) === 0, null);
  check("no 3D buildings switch outside Terrain 3D", (await page.getByRole("switch", { name: "3D buildings" }).count()) === 0, null);

  await openStyleCard();
  await page.getByRole("button", { name: "Terrain", exact: true }).click();
  const terrain = page.getByRole("switch", { name: "3D terrain" });
  await openStyleCard();
  await terrain.waitFor({ timeout: 5000 });
  const wanted = (await terrain.getAttribute("aria-checked")) === "true";
  if (wanted) await terrain.click();
  await page.waitForTimeout(1500);
  check("terrain off: flat map and no MapLibre terrain", (await page.evaluate(() => window.gerlinesMap.getMaxPitch() === 0 && !window.gerlinesMap.getTerrain())), null);

  await terrain.click();
  await page.waitForFunction(() => window.gerlinesMap.getPitch() > 40, null, { timeout: 8000 });
  const on = await page.evaluate(() => ({ pitch: window.gerlinesMap.getPitch(), max: window.gerlinesMap.getMaxPitch(), exaggeration: window.gerlinesMap.getTerrain()?.exaggeration }));
  check("terrain on: map tilts to about 50 degrees, terrain exaggeration 1.5", on.pitch > 40 && on.max === 60 && on.exaggeration === 1.5, on);
  check("the choice is stored", (await page.evaluate(() => localStorage.getItem("gerlines-terrain-3d"))) === "on", null);

  const buildings = page.getByRole("switch", { name: "3D buildings" });
  await openStyleCard();
  await buildings.waitFor({ timeout: 5000 });
  if ((await buildings.getAttribute("aria-checked")) !== "true") await buildings.click();
  await page.waitForTimeout(800);
  const layer = await page.evaluate(() => { const l = window.gerlinesMap.getLayer("building_3d"); return l && { type: l.type, minzoom: l.minzoom }; });
  check("buildings on: extrusion layer from zoom 14.5", layer && layer.type === "fill-extrusion" && layer.minzoom === 14.5, layer);

  const ticks = () => page.evaluate(async () => (await window.gerlinesLive.diagnostics()).ticks);
  await page.evaluate(() => window.gerlinesMap.jumpTo({ center: [7.0, 51.45], zoom: 13, pitch: 55, bearing: 0 }));
  await page.waitForTimeout(3000);
  for (let round = 0; round < 4; round++) {
    await page.evaluate(() => window.gerlinesMap.jumpTo({ zoom: 11 }));
    await page.waitForTimeout(1300);
    await page.evaluate(() => window.gerlinesMap.jumpTo({ zoom: 13 }));
    await page.waitForTimeout(1300);
  }
  const before = await ticks();
  await page.waitForTimeout(1500);
  const after = await ticks();
  check("zooming across zoom 12 four times leaves the trains moving (the worker keeps getting frame requests)", after - before > 30, { before, after });

  await page.keyboard.press("Escape");
  const allTrains = () => page.evaluate(() => window.gerlinesLive.trainsNear([0, 0], 1e6));
  const train = await page.evaluate(() => window.gerlinesLive.trainsNear([7.6, 50.4], 1)[0] ?? null);
  check("a train of the frames is found nearest to the Middle Rhine", train !== null, train);
  if (train) {
    await page.evaluate((t) => window.gerlinesMap.jumpTo({ center: [t.lon, t.lat], zoom: 14.2, pitch: 60, bearing: 350 }), train);
    await page.waitForTimeout(4000);
    const here = (await allTrains()).find((t) => t.id === train.id) ?? null;
    check("that train is still in the frames", here !== null, here);
    if (here) {
      await page.evaluate((t) => window.gerlinesMap.jumpTo({ center: [t.lon, t.lat] }), here);
      await page.waitForTimeout(600);
      const target = await page.evaluate(() => {
        const padding = window.gerlinesMap.getPadding();
        const box = window.gerlinesMap.getContainer().getBoundingClientRect();
        return { x: box.left + (box.width + padding.left - padding.right) / 2, y: box.top + (box.height + padding.top - padding.bottom) / 2 };
      });
      const offsets = [];
      for (let dy = -84; dy <= 28; dy += 14) for (let dx = -42; dx <= 42; dx += 14) offsets.push([dx, dy]);
      offsets.sort((a, b) => Math.hypot(a[0], a[1] + 28) - Math.hypot(b[0], b[1] + 28));
      let picked = null;
      await page.evaluate(() => window.gerlinesMap.doubleClickZoom.disable());
      for (const [dx, dy] of offsets) {
        await page.evaluate(() => window.gerlinesStore.getState().select(null));
        await page.mouse.click(target.x + dx, target.y + dy);
        await page.waitForTimeout(700);
        picked = await page.evaluate(() => window.gerlinesStore.getState().selectedId);
        if (picked !== null) break;
      }
      await page.evaluate(() => window.gerlinesMap.doubleClickZoom.enable());
      check("a click on that train selects it, the train found in the frames", picked === train.id, { target, picked, wanted: train.id });
    }
  }

  await openStyleCard();
  await terrain.click();
  await page.waitForFunction(() => window.gerlinesMap.getPitch() < 1, null, { timeout: 8000 });
  check("terrain off again: map back to a flat view", await page.evaluate(() => !window.gerlinesMap.getTerrain()), null);
  check("terrain off: no buildings switch and no extrusion layer", (await page.getByRole("switch", { name: "3D buildings" }).count()) === 0 && (await page.evaluate(() => !window.gerlinesMap.getLayer("building_3d"))), null);
  check("no MapLibre style diff warning", !warnings.some((text) => /style diff/i.test(text)), warnings.slice(0, 3));
  check("no console errors", errors.length === 0, errors.slice(0, 3));
  const failed = checks.filter((entry) => !entry.ok);
  return JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 1);
}
`;
writeFileSync(out, code);
