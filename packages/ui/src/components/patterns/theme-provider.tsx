import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_THEME, type ThemeName } from "../../theme/tokens.ts";

interface ThemeContextValue {
  readonly theme: ThemeName;
  readonly setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}

export interface ThemeProviderProps {
  readonly theme?: ThemeName;
  readonly defaultTheme?: ThemeName;
  readonly onThemeChange?: (theme: ThemeName) => void;
  readonly target?: HTMLElement;
  readonly children: ReactNode;
}

export function ThemeProvider({
  theme,
  defaultTheme = DEFAULT_THEME,
  onThemeChange,
  target,
  children,
}: ThemeProviderProps) {
  const [inner, setInner] = useState<ThemeName>(defaultTheme);
  const current = theme ?? inner;

  useLayoutEffect(() => {
    const element = target ?? document.documentElement;
    element.dataset.theme = current;
  }, [current, target]);

  const setTheme = useCallback(
    (next: ThemeName) => {
      if (theme === undefined) {
        setInner(next);
      }
      onThemeChange?.(next);
    },
    [theme, onThemeChange],
  );

  const value = useMemo(() => ({ theme: current, setTheme }), [current, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
