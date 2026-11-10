// biome-ignore-all format: the run-code command evaluates one bare function expression
async (page, config) => {
  const SHOTS = [
    { id: "01-overview-desktop-dark", viewport: [1440, 900], query: "" },
    { id: "02-overview-desktop-light", viewport: [1440, 900], query: "theme=light" },
    { id: "03-overview-large-dark", viewport: [2560, 1440], query: "" },
    { id: "04-city-frankfurt-dark", viewport: [1440, 900], query: "", camera: { center: [8.664, 50.103], zoom: 12.2, pitch: 45, bearing: -18 } },
    { id: "05-city-berlin-light-de", viewport: [1440, 900], query: "theme=light&lang=de", camera: { center: [13.39, 52.515], zoom: 12.4, pitch: 0, bearing: 0 } },
    { id: "06-terrain-middle-rhine", viewport: [1440, 900], query: "", style: "terrain", terrain3d: true, camera: { center: [7.72, 50.15], zoom: 12.3, pitch: 62, bearing: 200 } },
    { id: "07-satellite-cologne", viewport: [1440, 900], query: "", style: "satellite", camera: { center: [6.962, 50.94], zoom: 13.6, pitch: 30, bearing: 0 } },
    { id: "08-land-focus-bavaria-pl", viewport: [1440, 900], query: "lang=pl", land: "DE-BY" },
    { id: "09-selected-ice-desktop", viewport: [1440, 900], query: "", selectTrain: true },
    { id: "10-selected-ice-phone-de", viewport: [390, 844], scale: 3, mobile: true, query: "lang=de", selectTrain: true },
    { id: "11-overview-phone-dark", viewport: [390, 844], scale: 3, mobile: true, query: "" },
    { id: "12-overview-phone-light-pl", viewport: [390, 844], scale: 3, mobile: true, query: "theme=light&lang=pl" },
    { id: "13-overview-tablet-landscape-de", viewport: [1194, 834], scale: 2, mobile: true, query: "lang=de" },
    { id: "14-card-ice-delay-stops", viewport: [460, 900], scale: 2, path: "/train-states.html", query: "state=all-stops&layout=panel" },
    { id: "15-card-platform-change-phone-light", viewport: [390, 844], scale: 3, mobile: true, path: "/train-states.html", query: "state=platform-change&layout=sheet&expanded=1&theme=light" },
  ];

  const applyView = (shot) => {
    const map = window.gerlinesMap;
    if (shot.style) {
      window.gerlines.mapStyle(shot.style);
    }
    if (shot.terrain3d) {
      window.gerlines.terrain3d(true);
    }
    if (shot.land) {
      window.gerlines.focusLand(shot.land);
    }
    if (!shot.camera) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        map.jumpTo(shot.camera);
        resolve();
      }, 1500);
    });
  };

  const SELECT_VIEW = { zoom: 11, pitch: 0, bearing: 0 };

  const selectTrain = async ({ key, view }) => {
    if (key === null) {
      return "no train selected: set TRAIN_KEY to a frame key from apps/web/scripts/find-trips.ts";
    }
    const check = window.gerlinesCheck;
    if (!check) {
      return "no train selected: window.gerlinesCheck exists only in the dev server";
    }
    try {
      const result = await check.showTrain(key, view);
      return result.found
        ? `train ${key} selected at ${result.lon.toFixed(4)}, ${result.lat.toFixed(4)}`
        : `no train selected: train ${key} is not in the frames`;
    } catch (error) {
      return `no train selected: ${String(error)}`;
    }
  };

  const waitForTiles = () =>
    new Promise((resolve) => {
      const map = window.gerlinesMap;
      if (map.areTilesLoaded()) {
        resolve();
        return;
      }
      map.once("idle", () => resolve());
      setTimeout(resolve, 15000);
    });

  const prepareMap = async (tab, shot) => {
    await tab.waitForFunction(() => window.gerlinesMap?.loaded() && window.gerlines, null, {
      timeout: 30000,
    });
    await tab.evaluate(applyView, shot);
    const note = shot.selectTrain
      ? await tab.evaluate(selectTrain, { key: config.trainKey ?? null, view: SELECT_VIEW })
      : "";
    await tab.waitForTimeout(config.settleMs);
    await tab.evaluate(waitForTiles);
    await tab.waitForTimeout(1000);
    return note;
  };

  const capture = async (browser, shot) => {
    const context = await browser.newContext({
      viewport: { width: shot.viewport[0], height: shot.viewport[1] },
      deviceScaleFactor: shot.scale ?? 1,
      isMobile: shot.mobile ?? false,
      hasTouch: shot.mobile ?? false,
      reducedMotion: "reduce",
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on("pageerror", (error) => errors.push(String(error)));
    tab.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    try {
      const url = `${config.baseUrl}${shot.path ?? "/"}${shot.query ? `?${shot.query}` : ""}`;
      await tab.goto(url);
      let note = "";
      if (shot.path) {
        await tab.waitForTimeout(2500);
      } else {
        note = await prepareMap(tab, shot);
      }
      const file = `${config.outDir}/${config.prefix}-${shot.id}.png`;
      await tab.screenshot({ path: file });
      return { id: shot.id, file, url, note, errors: errors.slice(0, 5) };
    } finally {
      await context.close();
    }
  };

  const ids = config.shots.split(",");
  const wanted =
    config.shots === "all" ? SHOTS : SHOTS.filter((shot) => ids.some((id) => shot.id.startsWith(id)));
  if (wanted.length === 0) {
    throw new Error(`No shot matches ${config.shots}`);
  }
  const browser = page.context().browser();
  const done = [];
  for (const shot of wanted) {
    done.push(await capture(browser, shot));
  }
  return done;
}
