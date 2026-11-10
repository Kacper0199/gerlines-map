import { changeLocale, LOCALE_NAMES, LOCALE_TAGS, locales } from "@gerlines/i18n";
import { useCopy, useLocale } from "@gerlines/i18n/react";

export function LanguageSwitch() {
  const copy = useCopy();
  const active = useLocale();
  return (
    <fieldset className="lang" aria-label={copy.language.label}>
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={LOCALE_TAGS[locale]}
          aria-pressed={locale === active}
          title={LOCALE_NAMES[locale]}
          aria-label={`${locale.toUpperCase()} ${LOCALE_NAMES[locale]}`}
          onClick={() => {
            void changeLocale(locale);
          }}
        >
          {locale.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}
