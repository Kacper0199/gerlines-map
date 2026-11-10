// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: playwright-cli run-code accepts a single function expression
// biome-ignore format: run-code wraps the file in parentheses, a trailing semicolon would break it
async (page) => {
  const query = new URL(page.url()).searchParams;
  const group = query.get("run") ?? "main";
  const repetitions = Number(query.get("reps") ?? 1);
  const envFilter = query.get("env");
  const idFilter = query.get("only");
  const firstRepetition = Number(query.get("first") ?? 1);
  const tag = query.get("tag") ?? group;
  const origin = new URL(page.url()).origin;
  const sinkToken = query.get("sinkToken");
  if (!sinkToken) throw new Error("sinkToken query parameter missing: start the server with SP4_RESULTS_SINK=1 and SP4_SINK_TOKEN and open the page with &sinkToken=<token>");

  const cdp = await page.context().newCDPSession(page);
  const browserSession = await page.context().browser().newBrowserCDPSession();
  await cdp.send("Performance.enable");

  const metricsOf = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const byName = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
    const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
    const cpuOf = (type) =>
      processInfo
        .filter((process) => process.type === type)
        .reduce((sum, process) => sum + process.cpuTime, 0);
    return {
      taskSeconds: byName.TaskDuration,
      scriptSeconds: byName.ScriptDuration,
      layoutSeconds: byName.LayoutDuration,
      styleSeconds: byName.RecalcStyleDuration,
      timestamp: byName.Timestamp,
      gpuCpuSeconds: cpuOf("GPU"),
      rendererCpuSeconds: cpuOf("renderer"),
      browserCpuSeconds: cpuOf("browser"),
    };
  };

  const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
  const entries = await page.evaluate(async (name) => {
    await window.sp4Ready;
    return window.sp4.matrix(name);
  }, group);
  const selected = entries.filter(
    (entry) =>
      (!envFilter || entry.env === envFilter) && (!idFilter || entry.spec.id.includes(idFilter)),
  );

  const saveResult = async (fileName, body) => {
    const outcome = await page.evaluate(
      async ({ base, name, token, payload }) => {
        const response = await fetch(`${base}/__results/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "x-sp4-token": token },
          body: JSON.stringify(payload),
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
      { base: origin, name: fileName, token: sinkToken, payload: body },
    );
    if (!outcome.ok) {
      const failure = new Error(`saving ${fileName} failed with status ${outcome.status}: ${outcome.text}`);
      failure.fatal = true;
      throw failure;
    }
  };

  const summaries = [];
  let currentEnv = null;
  const applyEnvironment = async (name, environment) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: environment.width,
      height: environment.height,
      deviceScaleFactor: environment.deviceScaleFactor,
      mobile: environment.mobile,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: environment.cpuSlowdown });
    await page.reload();
    await page.evaluate(() => window.sp4Ready);
    currentEnv = name;
  };

  for (const entry of selected) {
    const environment = await page.evaluate((name) => window.sp4.environments[name], entry.env);
    if (currentEnv !== entry.env) await applyEnvironment(entry.env, environment);
    for (
      let repetition = firstRepetition;
      repetition < firstRepetition + repetitions;
      repetition++
    ) {
      const startedAt = new Date().toISOString();
      try {
        const spec = { ...entry.spec, workerSlowdown: environment.cpuSlowdown };
        const prepared = await page.evaluate((scenario) => window.sp4.prepare(scenario), spec);
        await cdp.send("HeapProfiler.collectGarbage");
        const heapBefore = await cdp.send("Runtime.getHeapUsage");
        const before = await metricsOf();
        const measured = await page.evaluate((ms) => window.sp4.measure(ms), entry.spec.measureMs);
        const after = await metricsOf();
        const heapAfter = await cdp.send("Runtime.getHeapUsage");
        await cdp.send("HeapProfiler.collectGarbage");
        const heapLive = await cdp.send("Runtime.getHeapUsage");
        const graphics = await page.evaluate(() => window.sp4.graphicsInfo());
        const wall = after.timestamp - before.timestamp;
        const result = {
          group: tag,
          id: entry.spec.id,
          env: entry.env,
          repetition,
          startedAt,
          spec,
          environment,
          graphics,
          prepared,
          measured,
          cdp: {
            wallSeconds: round(wall, 2),
            mainThreadBusyPercent: round(
              ((after.taskSeconds - before.taskSeconds) / wall) * 100,
              1,
            ),
            scriptPercent: round(((after.scriptSeconds - before.scriptSeconds) / wall) * 100, 1),
            layoutPercent: round(((after.layoutSeconds - before.layoutSeconds) / wall) * 100, 1),
            stylePercent: round(((after.styleSeconds - before.styleSeconds) / wall) * 100, 1),
            gpuProcessCpuPercent: round(
              ((after.gpuCpuSeconds - before.gpuCpuSeconds) / wall) * 100,
              1,
            ),
            rendererProcessCpuPercent: round(
              ((after.rendererCpuSeconds - before.rendererCpuSeconds) / wall) * 100,
              1,
            ),
            browserProcessCpuPercent: round(
              ((after.browserCpuSeconds - before.browserCpuSeconds) / wall) * 100,
              1,
            ),
            heapUsedBeforeMB: round(heapBefore.usedSize / 1048576, 1),
            heapUsedAfterMB: round(heapAfter.usedSize / 1048576, 1),
            heapLiveAfterGcMB: round(heapLive.usedSize / 1048576, 1),
            heapTotalAfterMB: round(heapAfter.totalSize / 1048576, 1),
          },
        };
        const name = `${tag}.${entry.env}.${entry.spec.id}.r${repetition}.ndjson`.replace(
          /[^A-Za-z0-9._-]/g,
          "-",
        );
        await saveResult(name, result);
        summaries.push(
          [
            entry.env,
            entry.spec.id,
            `r${repetition}`,
            `fps ${measured.probe.fps}`,
            `frame p50 ${measured.probe.frameMs.p50} p95 ${measured.probe.frameMs.p95} max ${measured.probe.frameMs.max}`,
            `longtasks ${measured.probe.longTasks}`,
            `worker p50 ${measured.renderer?.workerMs.total.p50 ?? "-"} p95 ${measured.renderer?.workerMs.total.p95 ?? "-"}`,
            `gpu p50 ${measured.gpuMs?.p50 ?? "-"} p95 ${measured.gpuMs?.p95 ?? "-"}`,
            `main ${result.cdp.mainThreadBusyPercent}%`,
            `visible ${measured.renderer?.visibleTrains.mean ?? "-"}`,
          ].join(" | "),
        );
      } catch (error) {
        if (error.fatal) throw error;
        summaries.push(
          `${entry.env} | ${entry.spec.id} | r${repetition} | FAILED ${String(error)}`,
        );
      }
    }
  }

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  return summaries;
}
