import { LOCALE_TAGS } from "@gerlines/i18n";
import { useLegalCopy } from "@gerlines/i18n/legal";
import { useLocale } from "@gerlines/i18n/react";
import { Badge } from "@gerlines/ui";
import { type ReactNode, useEffect } from "react";
import { CREDITS_PATH } from "../credits/path.ts";
import { IMPRINT_PATH, PRIVACY_PATH, SOURCES_PATH, withLanguage } from "./path.ts";

export const LINK = "focus-ring rounded-sm underline decoration-1 underline-offset-2";

export type LegalNavPage = "sources" | "credits" | "privacy" | "imprint";

export function External({
  href,
  rel,
  nowrap,
  children,
}: {
  href: string;
  rel?: string;
  nowrap?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={nowrap ? `${LINK} whitespace-nowrap` : LINK}
      target="_blank"
      rel={rel ?? "noopener noreferrer"}
    >
      {children}
    </a>
  );
}

export function Missing({ children }: { children?: ReactNode }) {
  const text = useLegalCopy().legal;
  return (
    <Badge variant="outline" className="text-ink-muted">
      {children ?? text.missing}
    </Badge>
  );
}

export function useLongDate(isoDay: string): string {
  const locale = useLocale();
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    dateStyle: "long",
    timeZone: "Europe/Berlin",
  }).format(Date.parse(`${isoDay}T12:00:00Z`));
}

export function LegalNav({ current }: { current: LegalNavPage }) {
  const copy = useLegalCopy();
  const pages: readonly (readonly [LegalNavPage, string, string])[] = [
    ["sources", SOURCES_PATH, copy.legal.sourcesLink],
    ["credits", CREDITS_PATH, copy.photos.creditsLink],
    ["privacy", PRIVACY_PATH, copy.legal.privacyLink],
    ["imprint", IMPRINT_PATH, copy.legal.imprintLink],
  ];
  return (
    <nav aria-label={copy.legal.navLabel}>
      <ul className="flex flex-wrap gap-x-4 gap-y-2 type-label">
        {pages.map(([page, href, label]) => (
          <li key={page}>
            {page === current ? (
              <a
                href={withLanguage(href)}
                aria-current="page"
                className="focus-ring rounded-sm text-ink"
              >
                {label}
              </a>
            ) : (
              <a href={withLanguage(href)} className={`${LINK} text-ink-muted hover:text-ink`}>
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function LegalHeader({ current }: { current: LegalNavPage }) {
  const copy = useLegalCopy();
  return (
    <header className="flex flex-col gap-3 border-b border-hairline pb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <a href={withLanguage("/")} className="focus-ring rounded-sm type-wordmark">
          {copy.brand.name}
        </a>
        <a href={withLanguage("/")} className={`${LINK} type-label`}>
          {copy.photos.creditsBack}
        </a>
      </div>
      <LegalNav current={current} />
    </header>
  );
}

export function LegalLayout({
  current,
  title,
  intro,
  children,
}: {
  current: Exclude<LegalNavPage, "credits">;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  const copy = useLegalCopy();
  useEffect(() => {
    document.title = `${title}, ${copy.brand.name}`;
  }, [title, copy]);
  return (
    <div className="min-h-dvh bg-background text-ink">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <LegalHeader current={current} />
        <main className="flex flex-col gap-8">
          <div className="flex max-w-[65ch] flex-col gap-2">
            <h1 className="type-headline max-sm:text-[28px]">{title}</h1>
            {intro}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className="flex flex-col gap-3">
      <h2 id={id ? `${id}-title` : undefined} className="type-title">
        {title}
      </h2>
      {children}
    </section>
  );
}
