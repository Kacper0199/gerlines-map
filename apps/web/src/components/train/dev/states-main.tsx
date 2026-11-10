import "../../../styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { themeForStyle } from "../../../map/style/map-styles.ts";
import { applyStartupPreferences } from "../../../startup.ts";
import { StatesPage } from "./StatesPage.tsx";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("The page has no root element");
  }
  const style = await applyStartupPreferences(window.location.search, window.localStorage);
  const theme = themeForStyle(style);
  document.body.style.overflow = "auto";
  createRoot(root).render(
    <StrictMode>
      <StatesPage theme={theme} search={window.location.search} />
    </StrictMode>,
  );
}

void start();
