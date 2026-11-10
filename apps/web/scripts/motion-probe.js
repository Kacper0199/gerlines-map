// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page) => {
  const url = page.url();
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error("Open the dev server address in this session first, for example playwright-cli -s=probe open http://127.0.0.1:5173/");
  }
  const observeMs = 75000;
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const metersPerDegree = 111195;
    const stats = { frames: 0, comparedSteps: 0, maxStepMeters: 0, stepsOver5m: 0, stepsOver50m: 0, idsChanges: 0 };
    window.__motionStats = stats;
    window.__resetMotionStats = () => {
      for (const key of Object.keys(stats)) {
        stats[key] = 0;
      }
    };
    let previous = null;

    const stepMeters = (group, before, index) => {
      const lat = group.positions[2 * index + 1];
      const east = (group.positions[2 * index] - before.positions[2 * index]) * Math.cos((lat * Math.PI) / 180);
      const north = lat - before.positions[2 * index + 1];
      return Math.hypot(east, north) * metersPerDegree;
    };

    const recordStep = (meters) => {
      stats.comparedSteps++;
      stats.maxStepMeters = Math.max(stats.maxStepMeters, meters);
      stats.stepsOver5m += meters > 5 ? 1 : 0;
      stats.stepsOver50m += meters > 50 ? 1 : 0;
    };

    const compareGroup = (before, group) => {
      if (!before || before.count !== group.count) {
        return;
      }
      for (let i = 0; i < group.count; i++) {
        const visible = before.alpha[i] !== 0 && group.fillColors[4 * i + 3] !== 0;
        if (visible) {
          recordStep(stepMeters(group, before, i));
        }
      }
    };

    const snapshot = (group) => ({
      count: group.count,
      positions: group.positions.slice(),
      alpha: group.fillColors.filter((_, index) => index % 4 === 3),
    });

    const onFrame = (groups) => {
      stats.frames++;
      const idsChanged = groups.some((group) => group.ids !== undefined);
      stats.idsChanges += idsChanged ? 1 : 0;
      if (previous && !idsChanged) {
        for (const [index, group] of groups.entries()) {
          compareGroup(previous[index], group);
        }
      }
      previous = groups.map(snapshot);
    };

    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (event.data.type === "frame") {
            onFrame(event.data.frame.groups);
          }
        });
      }
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.__resetMotionStats());
  await page.waitForTimeout(observeMs);
  return await page.evaluate(() => {
    const stats = window.__motionStats;
    return {
      frames: stats.frames,
      comparedSteps: stats.comparedSteps,
      maxStepMeters: Math.round(stats.maxStepMeters * 1000) / 1000,
      stepsOver5m: stats.stepsOver5m,
      stepsOver50m: stats.stepsOver50m,
      framesWithNewIds: stats.idsChanges,
    };
  });
}
