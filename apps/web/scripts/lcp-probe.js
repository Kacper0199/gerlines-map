// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page) => {
  const origin = "https://127.0.0.1:5193";
  const profile = "slow";
  const runs = 3;
  const settleMs = 25000;
  const path = "/?probe=1&replay=0.0001&tier=high";
  const profiles = {
    fast: { downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8, latency: 165 },
    slow: { downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (0.675 * 1024 * 1024) / 8, latency: 562.5 },
  };
  const browser = page.context().browser();
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      locale: "en-GB",
      timezoneId: "Europe/Berlin",
      colorScheme: "dark",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.route((url) => url.hostname === "tiles.openfreemap.org", async (route) => {
      const url = new URL(route.request().url());
      const target = url.pathname === "/planet" ? "/basemap/tiles.json" : url.pathname.replace(/^\/fonts/, "/basemap/fonts");
      await route.fulfill({ response: await route.fetch({ url: `${origin}${target}` }) });
    });
    await context.route((url) => !["127.0.0.1", "tiles.openfreemap.org"].includes(url.hostname), (route) => route.abort());
    const tab = await context.newPage();
    await tab.addInitScript(() => {
      window.__lcp = { entries: [], firstTrains: null };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__lcp.entries.push({
            ms: Math.round(entry.startTime),
            px2: entry.size,
            element: entry.element ? `${entry.element.tagName} ${String(entry.element.className).slice(0, 60)}` : null,
            text: entry.element ? (entry.element.textContent || "").slice(0, 50) : null,
          });
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
      const poll = async () => {
        try {
          const diagnostics = await window.gerlinesLive?.diagnostics?.();
          if (diagnostics && window.__lcp.firstTrains === null && diagnostics.trains > 0) {
            window.__lcp.firstTrains = Math.round(performance.now());
          }
        } catch {}
        setTimeout(poll, 250);
      };
      poll();
    });
    const session = await context.newCDPSession(tab);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", { offline: false, ...profiles[profile] });
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await tab.goto(`${origin}${path}`, { waitUntil: "commit" });
    await tab.waitForTimeout(settleMs);
    results.push({
      run,
      ...(await tab.evaluate(() => {
        const paint = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]));
        const navigation = performance.getEntriesByType("navigation")[0];
        return {
          firstContentfulPaint: paint["first-contentful-paint"] ?? null,
          lcp: window.__lcp.entries,
          domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
          load: Math.round(navigation.loadEventEnd),
          firstTrainsDrawn: window.__lcp.firstTrains,
        };
      })),
    });
    await context.close();
  }
  return JSON.stringify({ profile, origin, results }, null, 1);
}
