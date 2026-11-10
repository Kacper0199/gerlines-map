// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page) => {
  const url = page.url();
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error("Open the dev server address in this session first, for example playwright-cli -s=probe open http://127.0.0.1:5173/");
  }
  const target = new URL(url);
  target.searchParams.set("probe", "1");
  target.searchParams.set("repaint", "always");
  const warmUpMs = 6000;
  const durationMs = 60000;
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    await page.goto(target.href);
    await page.waitForTimeout(warmUpMs);
    return await page.evaluate(async (duration) => {
      const frameTimes = [];
      const longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
        }
      });
      observer.observe({ type: "longtask" });
      const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
      await new Promise((resolve) => {
        const started = performance.now();
        let previous = started;
        const tick = (now) => {
          frameTimes.push(now - previous);
          previous = now;
          if (now - started < duration) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
      observer.disconnect();
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const at = (fraction) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
      const total = frameTimes.reduce((sum, value) => sum + value, 0);
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        viewport: [innerWidth, innerHeight],
        devicePixelRatio,
        cpuThrottle: 4,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown",
        frames: frameTimes.length,
        seconds: Math.round(total / 100) / 10,
        fps: Math.round(((1000 * frameTimes.length) / total) * 10) / 10,
        frameMs: {
          p50: Math.round(at(0.5) * 100) / 100,
          p95: Math.round(at(0.95) * 100) / 100,
          p99: Math.round(at(0.99) * 100) / 100,
          max: Math.round(sorted[sorted.length - 1] * 100) / 100,
        },
        framesOver33ms: frameTimes.filter((value) => value > 33.4).length,
        longTasksOver50ms: {
          count: longTasks.length,
          maxMs: Math.round(Math.max(0, ...longTasks) * 10) / 10,
          totalMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0) * 10) / 10,
        },
        heapMb: {
          before: Math.round(heapBefore / 1048576),
          after: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
        },
      };
    }, durationMs);
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.send("Emulation.clearDeviceMetricsOverride");
  }
}
