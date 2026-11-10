// biome-ignore-all format: playwright-cli wraps this file as an expression, so it must not end with a semicolon
async (page) => {
  await page.waitForFunction(() => window.__sp5 !== undefined, null, { timeout: 20000 });
  return await page.evaluate(async () => {
    const probe = window.__sp5;
    await probe.ready();
    probe.jumpTo(8.68, 50.11, 9);
    await probe.ready();
    const identity = await probe.run({ sequence: ["de", "pl", "en"] });
    const timings = await probe.run({
      sequence: ["de", "pl", "en", "pl", "de", "en", "de", "pl", "en", "de", "pl", "en"],
    });
    return JSON.stringify({ identity, timings, labels: probe.labelFields().slice(0, 4) });
  });
}
