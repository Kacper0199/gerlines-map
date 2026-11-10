import { changeLocale, isLocale, LOCALE_NAMES, locales } from "@gerlines/i18n";
import { useCopy, useLocale } from "@gerlines/i18n/react";
import { LanguageSwitch, type LocaleOption } from "@gerlines/ui";

const OPTIONS: readonly LocaleOption[] = locales.map((code) => ({
  code,
  short: code.toUpperCase(),
  name: LOCALE_NAMES[code],
}));

export function LocaleSwitch({ className }: { className?: string }) {
  const copy = useCopy();
  const locale = useLocale();
  return (
    <LanguageSwitch
      {...(className === undefined ? {} : { className })}
      label={copy.language.label}
      locales={OPTIONS}
      value={locale}
      onValueChange={(code) => {
        if (isLocale(code)) {
          void changeLocale(code);
        }
      }}
    />
  );
}
