#!/usr/bin/env node
// End-to-end check of WP-7.6b: History opens the timeline, an hour plays, Pause holds the clock, the speed and the
// scrubber move it, the address carries the moment, Back to live ends it, Back returns to it. Writes a
// playwright-cli run-code script.
// Usage: node e2e/playback.mjs <base url> <out.js> [window start ISO, default 2026-10-25T12:00:00Z]
// The page needs `playback serve` behind `LIVE_PROXY_TARGET`, started with --now before the hours' age limit; the script
// moves the page clock to ten minutes past the hour after the last one the server lists (UTC), so the picker shows it.
import { writeFileSync } from "node:fs";

const [base, out, start = "2026-10-25T12:00:00Z"] = process.argv.slice(2);
if (!(base && out)) {
  process.stderr.write("usage: node e2e/playback.mjs <base url> <out.js> [window start ISO]\n");
  process.exit(2);
}
const pageNow = new Date(Date.parse(start) + 4 * 3600 * 1000).toISOString();

const code = `async (page) => {
  const base = ${JSON.stringify(base.replace(/\/+$/, ""))};
  const start = ${JSON.stringify(start)};
  const checks = [];
  const check = (name, ok, seen) => checks.push({ name, ok: Boolean(ok), seen });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript((now) => {
    const Real = Date;
    const offset = Real.parse(now) - Real.now();
    const shifted = () => Real.now() + offset;
    globalThis.Date = new Proxy(Real, {
      construct: (target, args) => (args.length ? new target(...args) : new target(shifted())),
      get: (target, prop) => (prop === "now" ? shifted : Reflect.get(target, prop)),
    });
  }, ${JSON.stringify(pageNow)});
  const until = async (name, predicate, argument, timeout = 15000) => {
    try {
      await page.waitForFunction(predicate, argument, { timeout });
      check(name, true, page.url());
    } catch (error) {
      check(name, false, String(error).slice(0, 120));
    }
  };
  const clock = () => page.locator("[data-slot=playback-clock]");
  const seconds = async () => {
    const [h, m, s] = (await clock().textContent()).split(":").map(Number);
    return h * 3600 + m * 60 + s;
  };

  await page.goto(base + "/?lang=en");
  const history = page.getByRole("button", { name: "History" });
  await history.waitFor({ timeout: 20000 });
  check("History is offered with the live source", await history.isVisible(), null);
  check("no Back to live before a playback", (await page.getByRole("button", { name: "Back to live" }).count()) === 0, null);

  await history.click();
  const panel = page.getByRole("region", { name: "Playback of a past hour" });
  await panel.waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Show this hour" }).click();
  await clock().waitFor({ timeout: 20000 });
  await until("the bar says Playback", () => document.querySelector("[data-slot=live-bar]")?.textContent?.includes("Playback"));
  await until("the address carries the moment", () => /at=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z/.test(location.search));

  await until("trains are on the map", async () => (await window.gerlinesLive.diagnostics()).trains > 100, null, 30000);

  const first = await seconds();
  await page.waitForTimeout(3000);
  const second = await seconds();
  check("the clock runs at 1x", second - first >= 2 && second - first <= 5, { first, second });

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(300);
  const held = await seconds();
  await page.waitForTimeout(2500);
  check("Pause holds the clock", (await seconds()) === held, held);
  check("the button now offers Play", await page.getByRole("button", { name: "Play", exact: true }).isVisible(), null);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "30x" }).click();
  const before = await seconds();
  await page.waitForTimeout(2000);
  const after = await seconds();
  check("30x runs the clock about thirty times faster", after - before >= 40 && after - before <= 90, { before, after });

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Position in the hour" });
  await slider.focus();
  const at = await seconds();
  await page.keyboard.press("PageUp");
  await until("the scrubber seeks with the keyboard", (was) => {
    const [h, m, s] = document.querySelector("[data-slot=playback-clock]").textContent.split(":").map(Number);
    return h * 3600 + m * 60 + s > was + 200;
  }, at);

  const length = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Back to live" }).click();
  await until("Back to live takes the moment out of the address", () => !location.search.includes("at="));
  check("Back to live removes its button", (await page.getByRole("button", { name: "Back to live" }).count()) === 0, null);
  check("the bar no longer says Playback", !(await page.locator("[data-slot=live-bar]").textContent()).includes("Playback"), null);

  await page.goBack();
  await until("Back returns to the playback", () => location.search.includes("at="));
  await clock().waitFor({ timeout: 15000 });
  check("no page errors", errors.length === 0, errors);
  const failed = checks.filter((entry) => !entry.ok);
  return JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, historyLength: length, checks }, null, 1);
}`;
writeFileSync(out, code);
process.stdout.write(`${out}\n`);
