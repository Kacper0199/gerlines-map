import { changeLocale, isLocale } from "@gerlines/i18n";
import { useLocale } from "@gerlines/i18n/react";
import { useState } from "react";
import {
  LanguageSwitch,
  type ThemeName,
  ThemeProvider,
  ToggleGroup,
  ToggleGroupItem,
  TooltipProvider,
} from "../src/index.ts";
import { Actions } from "./sections/actions.tsx";
import { Atoms } from "./sections/atoms.tsx";
import { Controls } from "./sections/controls.tsx";
import { Foundations } from "./sections/foundations.tsx";
import { Surfaces } from "./sections/surfaces.tsx";
import { LOCALE_OPTIONS, stringsFor } from "./strings.ts";

function initialTheme(): ThemeName {
  return new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
}

function selectLocale(code: string) {
  if (isLocale(code)) {
    void changeLocale(code);
  }
}

function Header({ theme, onTheme }: { theme: ThemeName; onTheme: (theme: ThemeName) => void }) {
  const locale = useLocale();
  const strings = stringsFor(locale);
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex max-w-prose flex-col gap-1">
        <h1 className="type-wordmark">{strings.brand} component sheet</h1>
        <p className="type-body text-ink-muted">Direction B Fahrplan. {strings.note}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label="Theme"
          value={[theme]}
          onValueChange={(group) => {
            const next = group[0];
            if (next === "dark" || next === "light") {
              onTheme(next);
            }
          }}
        >
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
        </ToggleGroup>
        <LanguageSwitch
          label={strings.languageLabel}
          locales={LOCALE_OPTIONS}
          value={locale}
          onValueChange={selectLocale}
        />
      </div>
    </header>
  );
}

export function App() {
  const [theme, setTheme] = useState<ThemeName>(initialTheme);
  const locale = useLocale();
  const strings = stringsFor(locale);
  return (
    <ThemeProvider theme={theme} onThemeChange={setTheme}>
      <TooltipProvider>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4 py-6 sm:px-6">
          <Header theme={theme} onTheme={setTheme} />
          <main className="flex flex-col gap-8">
            <Foundations theme={theme} strings={strings} />
            <Actions strings={strings} />
            <Controls strings={strings} onLocale={selectLocale} />
            <Atoms strings={strings} />
            <Surfaces strings={strings} />
          </main>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
