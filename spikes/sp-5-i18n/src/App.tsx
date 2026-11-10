import { useCopy } from "@gerlines/i18n/react";
import { Attribution } from "./components/Attribution.tsx";
import { LanguageSwitch } from "./components/LanguageSwitch.tsx";
import { Legend } from "./components/Legend.tsx";
import { LiveBar } from "./components/LiveBar.tsx";
import { MapView } from "./components/MapView.tsx";
import { TrainCard } from "./components/TrainCard.tsx";
import { ZoomControls } from "./components/ZoomControls.tsx";

export function App() {
  const copy = useCopy();
  return (
    <main>
      <MapView />
      <div className="ui">
        <header className="card brand">
          <h1>{copy.brand.name}</h1>
          <p className="muted">{copy.brand.tagline}</p>
        </header>
        <LanguageSwitch />
        <div className="sheet">
          <TrainCard />
          <Legend />
        </div>
        <LiveBar />
        <ZoomControls />
      </div>
      <Attribution />
    </main>
  );
}
