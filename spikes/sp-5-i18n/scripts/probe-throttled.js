// biome-ignore-all format: playwright-cli wraps this file as an expression, so it must not end with a semicolon
async (page) => {
  await page.waitForFunction(() => window.__sp5 !== undefined, null, { timeout: 20000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    return await page.evaluate(async () => {
      const probe = window.__sp5;
      const busy = () => {
        const started = performance.now();
        let total = 0;
        for (let index = 0; index < 2e7; index += 1) {
          total += index % 7;
        }
        return total < 0 ? -1 : performance.now() - started;
      };
      const busyMs = busy();
      await probe.ready();
      const result = await probe.run({
        sequence: ["de", "pl", "en", "pl", "de", "en", "de", "pl", "en", "de", "pl", "en"],
        idleTimeoutMs: 8000,
      });
      const { commitMs, paintMs, idleMs, longTasks, sameMap, sameCanvas } = result;
      return JSON.stringify({ throttle: 4, busyMs, commitMs, paintMs, idleMs, longTasks, sameMap, sameCanvas });
    });
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
}
