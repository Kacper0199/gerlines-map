import { ThemeProvider } from "@gerlines/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { themeForStyle } from "../map/style/map-styles.ts";
import { applyStartupPreferences } from "../startup.ts";
import { CreditsPage } from "./CreditsPage.tsx";

export async function mountCredits(root: HTMLElement): Promise<void> {
  const style = await applyStartupPreferences(window.location.search, window.localStorage);
  document.body.style.overflow = "auto";
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={themeForStyle(style)}>
        <CreditsPage />
      </ThemeProvider>
    </StrictMode>,
  );
}
