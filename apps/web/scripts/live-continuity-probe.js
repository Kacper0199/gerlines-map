// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page) => {
  const url = page.url();
  if (!url.startsWith("http://127.0.0.1:") || !url.includes("probe=1") || !url.includes("replay=")) {
    throw new Error("Open the page with ?replay=10&probe=1 against a replay server first, for example playwright-cli -s=probe open 'http://127.0.0.1:5821/?replay=10&probe=1'");
  }
  const target = new URL(url);
  target.searchParams.set("probe", "1");
  target.searchParams.set("repaint", "always");
  const warmUpMs = 30000;
  const durationMs = 240000;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(target.href);
  await page.waitForTimeout(warmUpMs);
  await page.evaluate(() => window.gerlinesLive.continuity("start", 1));
  const frames = await page.evaluate(async (duration) => {
    const frameTimes = [];
    const longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    await new Promise((resolve) => {
      const started = performance.now();
      let previous = started;
      const tick = (now) => {
        frameTimes.push(now - previous);
        previous = now;
        if (now - started < duration) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    const total = frameTimes.reduce((sum, value) => sum + value, 0);
    return {
      frames: frameTimes.length,
      seconds: Math.round(total / 100) / 10,
      fps: Math.round(((1000 * frameTimes.length) / total) * 10) / 10,
      frameMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] },
      framesOver33ms: frameTimes.filter((value) => value > 33.4).length,
      longTasksOver50ms: { count: longTasks.length, maxMs: Math.max(0, ...longTasks) },
    };
  }, durationMs);
  const continuity = await page.evaluate(() => window.gerlinesLive.continuity("stop"));
  const diagnostics = await page.evaluate(() => window.gerlinesLive.diagnostics());
  return { frames, continuity, diagnostics };
}
