// biome-ignore format: playwright-cli run-code takes a bare function expression, no trailing semicolon
async (page) => {
  const base = "http://127.0.0.1:8765";
  const out = "raw/screenshots/overlays";
  await page.goto(`${base}/data/index.json`);
  const names = JSON.parse(await page.locator("body").textContent());
  for (const name of names) {
    await page.goto(`${base}/?c=${name}`);
    await page.waitForSelector("body[data-ready='1']", { timeout: 60000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/sp-3-${name}.png` });
  }
  return names.length;
}
