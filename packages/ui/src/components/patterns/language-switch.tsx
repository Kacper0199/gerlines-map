import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";

export interface LocaleOption {
  readonly code: string;
  readonly short: string;
  readonly name: string;
}

export interface LanguageSwitchProps {
  readonly label: string;
  readonly locales: readonly LocaleOption[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (code: string) => void;
  readonly className?: string;
}

export function LanguageSwitch({
  label,
  locales,
  value,
  defaultValue,
  onValueChange,
  className,
}: LanguageSwitchProps) {
  const [inner, setInner] = useState(defaultValue ?? locales[0]?.code ?? "");
  const current = value ?? inner;

  function select(group: readonly string[]) {
    const next = group[0];
    if (next === undefined) {
      return;
    }
    if (value === undefined) {
      setInner(next);
    }
    onValueChange?.(next);
  }

  return (
    <ToggleGroup aria-label={label} className={className} value={[current]} onValueChange={select}>
      {locales.map((locale) => (
        <ToggleGroupItem
          key={locale.code}
          value={locale.code}
          lang={locale.code}
          aria-label={`${locale.short}, ${locale.name}`}
        >
          {locale.short}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
