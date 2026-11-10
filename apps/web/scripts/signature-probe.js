// biome-ignore-all format: the run-code command evaluates one bare function expression
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one probe run by run-code, a single bare function expression
async (page) => {
  const url = new URL(page.url());
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Open the dev server address in this session first, with the parameters: ?replay=1&probe=1&sig=fly|clip&keys=<trip keys>&w=1440&h=900&dpr=1&cpu=1&select=off|on&tilt=off&style=dark|light|terrain&out=<abs folder>&prefix=<name>");
  }
  const params = url.searchParams;
  const mode = params.get("sig") ?? "fly";
  const keys = (params.get("keys") ?? "").split(",").filter(Boolean).map(Number);
  const width = Number(params.get("w") ?? 1440);
  const height = Number(params.get("h") ?? 900);
  const out = params.get("out") ?? "";
  const prefix = params.get("prefix") ?? "F1";
  const style = params.get("style") ?? "";
  const cpu = Number(params.get("cpu") ?? 1);
  const dpr = Number(params.get("dpr") ?? 1);
  if (cpu > 1 || dpr > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: dpr > 1 });
    await session.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  } else {
    await page.setViewportSize({ width, height });
  }
  await page.goto(url.href);
  await page.waitForTimeout(7000);
  if (style) await page.evaluate((s) => window.gerlines.mapStyle(s), style);
  await page.waitForTimeout(1500);

  const resetView = async () => {
    await page.evaluate(() => {
      window.gerlinesStore.getState().select(null);
    });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.gerlinesMap.jumpTo({ center: [10.4, 51.1], zoom: 5.6, pitch: 0, bearing: 0 }));
    await page.waitForTimeout(1500);
  };

  if (params.get("tilt") === "off") await page.evaluate(() => window.gerlinesStore.getState().setSelectionTilt(false));
  await resetView();
  const camera = () => ({ t: performance.now(), z: window.gerlinesMap.getZoom(), p: window.gerlinesMap.getPitch(), c: window.gerlinesMap.getCenter(), m: window.gerlinesMap.isMoving() });

  if (mode === "clip") {
    const frames = [];
    const key = keys[0];
    await page.evaluate((k) => window.gerlinesStore.getState().select(`live:${k}`), key);
    const started = Date.now();
    let index = 0;
    while (Date.now() - started < 2800) {
      const at = Date.now() - started;
      await page.screenshot({ path: `${out}/${prefix}-${String(index).padStart(2, "0")}-${String(at).padStart(4, "0")}ms.png`, type: "png" });
      frames.push(at);
      index += 1;
    }
    const final = await page.evaluate(camera);
    return { mode, key, shots: frames, final: { zoom: final.z, pitch: final.p, moving: final.m } };
  }

  if (mode === "fly") {
    await page.evaluate(() => {
      window.__sig = { frames: [], cam: [] };
      const sig = window.__sig;
      let previous = performance.now();
      sig.running = true;
      const tick = (now) => {
        sig.frames.push(now - previous);
        previous = now;
        const m = window.gerlinesMap;
        sig.cam.push([Math.round(now), +m.getZoom().toFixed(2), +m.getPitch().toFixed(1), m.isMoving()]);
        if (sig.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const key = keys[0];
    const t0 = await page.evaluate(() => performance.now());
    if (params.get("select") !== "off") {
      await page.evaluate((k) => window.gerlinesStore.getState().select(`live:${k}`), key);
    }
    await page.waitForTimeout(3200);
    const result = await page.evaluate((start) => {
      const sig = window.__sig;
      sig.running = false;
      const frames = sig.frames.slice(1);
      const sorted = [...frames].sort((a, b) => a - b);
      const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
      const cam = sig.cam.map(([t, z, p, m]) => [Math.round(t - start), z, p, m]);
      const last = cam.filter((c) => c[3]).pop();
      const first = cam.find((c) => c[3]);
      const window_ = frames.length;
      return {
        frames: window_,
        p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), p99: +at(0.99).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1),
        over33: frames.filter((v) => v > 33.4).length, over50: frames.filter((v) => v > 50).length,
        motionStartMs: first ? first[0] : null, motionEndMs: last ? last[0] : null,
        every100ms: cam.filter((_, i) => i % 6 === 0).slice(0, 36),
      };
    }, t0);
    return { mode, key, result };
  }
  throw new Error(`unknown sig mode ${mode}`);
}
