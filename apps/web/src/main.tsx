import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadMapView } from "./components/map-loader.ts";
import { CREDITS_PATH } from "./credits/path.ts";
import { legalPageOf } from "./legal/path.ts";
import { startLiveEarly } from "./live/early-start.ts";
import { geoFilesFor } from "./map/geo-base.ts";
import { detectGpuTier, hasWebgl2 } from "./map/terrain/gpu-tier.ts";
import { initialBuildings, initialTerrain3d } from "./map/terrain/policy.ts";
import { warmSchemas, whenIdle } from "./schema-loaders.ts";
import { initialSelectionTilt } from "./signature/tilt-policy.ts";
import { applyStartupPreferences } from "./startup.ts";
import { useAppStore } from "./state/store.ts";

async function start(): Promise<void> {
  const credits = document.getElementById("root");
  if (credits && window.location.pathname === CREDITS_PATH) {
    const { mountCredits } = await import("./credits/mount.tsx");
    await mountCredits(credits);
    return;
  }
  const legal = legalPageOf(window.location.pathname);
  if (credits && legal) {
    const { mountLegal } = await import("./legal/mount.tsx");
    await mountLegal(credits, legal);
    return;
  }
  void loadMapView().then(
    () => whenIdle(warmSchemas),
    () => undefined,
  );
  void geoFilesFor(window.location.origin).national();
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("The page has no root element");
  }
  const mapStyle = await applyStartupPreferences(window.location.search, window.localStorage);
  const tier = detectGpuTier();
  useAppStore.setState({
    gpuTier: tier,
    terrainWanted: initialTerrain3d(tier, window.localStorage),
    buildings: initialBuildings(tier, window.localStorage),
    selectionTilt: initialSelectionTilt(window.localStorage),
  });
  useAppStore.getState().setMapStyle(mapStyle);
  if (hasWebgl2()) startLiveEarly(useAppStore.getState().theme, window.location.search);
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has("probe")) {
    const { select, setFocusLand, setMapStyle, setTerrain3d } = useAppStore.getState();
    Object.assign(window, {
      gerlines: { select, focusLand: setFocusLand, mapStyle: setMapStyle, terrain3d: setTerrain3d },
    });
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
