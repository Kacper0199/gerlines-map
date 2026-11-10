import "@fontsource/overpass/400.css";
import "@fontsource/overpass/600.css";
import "@fontsource/overpass/800.css";
import "@fontsource/overpass-mono/400.css";
import "@fontsource/overpass-mono/600.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { applyDocumentLanguage, changeLocale, isLocale } from "@gerlines/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installProbe } from "./probe.ts";

async function start() {
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested !== null && isLocale(requested)) {
    await changeLocale(requested);
  }
  applyDocumentLanguage();
  installProbe();
  const root = document.getElementById("root");
  if (root === null) {
    throw new Error("The page has no root element");
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
