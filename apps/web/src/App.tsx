import { ThemeProvider } from "@gerlines/ui";
import { Suspense, useRef } from "react";
import { SkipLink } from "./a11y/SkipLink.tsx";
import { MapErrorBoundary } from "./components/MapErrorBoundary.tsx";
import { LazyMapView } from "./components/map-loader.ts";
import { ProfileTooltipHost } from "./components/ProfileTooltipHost.tsx";
import { SearchMap } from "./components/SearchMap.tsx";
import { DesktopShell } from "./components/shell/DesktopShell.tsx";
import { PhoneShell } from "./components/shell/PhoneShell.tsx";
import { PHONE_QUERY, useMediaQuery } from "./hooks/use-media-query.ts";
import { InViewHost } from "./inview/InViewHost.tsx";
import { JourneyPlannerMap } from "./journeys/JourneyPlanner.tsx";
import type { TrainMap } from "./map/train-map.ts";
import { useAppStore } from "./state/store.ts";
import { storeMapStyle } from "./theme/preference.ts";

export function App() {
  const handle = useRef<TrainMap | null>(null);
  const theme = useAppStore((state) => state.theme);
  const setMapStyle = useAppStore((state) => state.setMapStyle);
  const markMapInteracted = useAppStore((state) => state.markMapInteracted);
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <ThemeProvider
      theme={theme}
      onThemeChange={(next) => {
        setMapStyle(next);
        storeMapStyle(window.localStorage, next);
      }}
    >
      <main>
        <SkipLink />
        <MapErrorBoundary>
          <Suspense fallback={<div className="fixed inset-0 bg-map-land" />}>
            <LazyMapView handle={handle} />
          </Suspense>
        </MapErrorBoundary>
        <ProfileTooltipHost />
        <InViewHost handle={handle} />
        <SearchMap handle={handle} />
        <JourneyPlannerMap handle={handle} />
        {phone ? (
          <PhoneShell />
        ) : (
          <DesktopShell
            onZoom={(delta) => {
              markMapInteracted();
              handle.current?.zoomBy(delta);
            }}
          />
        )}
      </main>
    </ThemeProvider>
  );
}
