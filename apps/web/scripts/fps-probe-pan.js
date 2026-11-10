// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page) => {
  const config = {
    phone: true,
    cpuThrottle: 4,
    query: "&carRadiusKm=150&carCull=0",
    center: [7.1, 51.45],
    zoom: 17,
    pitch: 60,
    warmUpMs: 8000,
    durationMs: 20000,
    panPxPerSecond: 150,
    flipMs: 3000,
  };
  const url = page.url();
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error("Open the server address in this session first, for example playwright-cli -s=probe open http://127.0.0.1:5173/");
  }
  const origin = new URL(url).origin;
  const session = await page.context().newCDPSession(page);
  if (config.phone) {
    await session.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } else {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await session.send("Emulation.setCPUThrottlingRate", { rate: config.cpuThrottle });
  await session.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  try {
    await page.goto(`${origin}/?replay=1&probe=1&repaint=always${config.query}`);
    await page.waitForFunction(() => window.gerlinesMap && window.gerlinesLive, null, { timeout: 30000 });
    await page.evaluate((view) => {
      window.gerlinesMap.setMaxPitch(70);
      window.gerlinesMap.jumpTo(view);
    }, { center: config.center, zoom: config.zoom, pitch: config.pitch });
    await page.waitForTimeout(config.warmUpMs);
    const workerBefore = await page.evaluate(() => window.gerlinesLive.diagnostics().then((d) => ({ cars: d.cars, tickMs: d.tickMs, ticks: d.ticks })));
    if (!(workerBefore.cars.instances > 0)) {
      throw new Error(`No cars were drawn after the warm-up (trains ${workerBefore.cars.trains}, instances ${workerBefore.cars.instances}): the models did not load or the scene has no train; the frame numbers would mean nothing.`);
    }
    const before = await metrics();
    const result = await page.evaluate(async (c) => {
      const frameTimes = [];
      const longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const map = window.gerlinesMap;
      await new Promise((resolve) => {
        const started = performance.now();
        let previous = started;
        let direction = 1;
        let flippedAt = started;
        const tick = (now) => {
          const dt = now - previous;
          frameTimes.push(dt);
          previous = now;
          if (now - flippedAt > c.flipMs) {
            direction = -direction;
            flippedAt = now;
          }
          map.panBy([(direction * c.panPxPerSecond * dt) / 1000, 0], { animate: false });
          if (now - started < c.durationMs) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      observer.disconnect();
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
      const total = frameTimes.reduce((sum, value) => sum + value, 0);
      const round = (value) => Math.round(value * 100) / 100;
      const diagnostics = await window.gerlinesLive.diagnostics();
      return {
        frames: frameTimes.length,
        fps: Math.round(((1000 * frameTimes.length) / total) * 10) / 10,
        frameMs: { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]) },
        framesOver33ms: frameTimes.filter((value) => value > 33.4).length,
        longTasks: { count: longTasks.length, maxMs: round(Math.max(0, ...longTasks)) },
        cars: diagnostics.cars,
        slotsPerInstance: diagnostics.cars.instances > 0 ? Math.round((100 * diagnostics.cars.slots) / diagnostics.cars.instances) / 100 : null,
        workerTickMs: diagnostics.tickMs,
        workerTicks: diagnostics.ticks,
        heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
      };
    }, config);
    const after = await metrics();
    const seconds = (name) => Math.round((after[name] - before[name]) * 1000) / 1000;
    if (!(result.cars.instances > 0)) throw new Error("No cars were drawn at the end of the run.");
    return {
      config,
      ...result,
      workerBefore,
      slotMovesDuringRun: result.cars.slotMoves - workerBefore.cars.slotMoves,
      mainThreadSeconds: { tasks: seconds("TaskDuration"), script: seconds("ScriptDuration"), cpu: seconds("ThreadTime") },
    };
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.send("Emulation.clearDeviceMetricsOverride");
  }
}
