import { ThemeProvider } from "@gerlines/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { themeForStyle } from "../map/style/map-styles.ts";
import { applyStartupPreferences } from "../startup.ts";
import { ImprintPage } from "./ImprintPage.tsx";
import { PrivacyPage } from "./PrivacyPage.tsx";
import type { LegalPage } from "./path.ts";
import { SourcesPage } from "./SourcesPage.tsx";

const PAGES = { sources: SourcesPage, privacy: PrivacyPage, imprint: ImprintPage } as const;

export async function mountLegal(root: HTMLElement, page: LegalPage): Promise<void> {
  const style = await applyStartupPreferences(window.location.search, window.localStorage);
  document.body.style.overflow = "auto";
  const Page = PAGES[page];
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={themeForStyle(style)}>
        <Page />
      </ThemeProvider>
    </StrictMode>,
  );
}
