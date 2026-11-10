import { useLegalCopy } from "@gerlines/i18n/legal";
import { PHOTOS_PATH, type PhotoCredit, PhotoCredits } from "@gerlines/schema/photos";
import { Button } from "@gerlines/ui";
import { useEffect, useRef, useState } from "react";
import { focusPosition, photoSources, photoTitle } from "../components/train/card/VehicleBlock.tsx";
import { LegalHeader } from "../legal/LegalLayout.tsx";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

type Load =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly retrying: boolean }
  | { readonly state: "ready"; readonly photos: readonly PhotoCredit[]; readonly retried: boolean };

export async function loadCredits(fetcher: Fetcher, signal?: AbortSignal): Promise<PhotoCredit[]> {
  const response = await fetcher(PHOTOS_PATH, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`photo credits answered ${response.status}`);
  }
  return PhotoCredits.parse(await response.json()).photos;
}

const LINK = "focus-ring rounded-sm underline decoration-1 underline-offset-2";

function External({ href, rel, children }: { href: string; rel?: string; children: string }) {
  return (
    <a href={href} className={LINK} target="_blank" rel={rel ?? "noreferrer"}>
      {children}
    </a>
  );
}

function Credit({ photo }: { photo: PhotoCredit }) {
  const text = useLegalCopy().photos;
  return (
    <li className="card-surface flex flex-col overflow-hidden">
      <img
        src={photo.small.url}
        srcSet={photoSources(photo)}
        sizes="(max-width: 640px) 100vw, 320px"
        width={photo.small.width}
        height={photo.small.height}
        alt={photo.seriesName}
        loading="lazy"
        decoding="async"
        style={{ objectPosition: focusPosition(photo) }}
        className="aspect-[3/2] w-full bg-raised object-cover"
      />
      <div className="flex flex-col gap-2 p-4">
        <h2 className="type-body-strong">{photo.seriesName}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 type-caption">
          <dt className="text-ink-muted">{text.title}</dt>
          <dd className="min-w-0 break-words">
            <External href={photo.sourceUrl}>{photoTitle(photo)}</External>
          </dd>
          <dt className="text-ink-muted">{text.author}</dt>
          <dd className="min-w-0 break-words">
            {photo.authorUrl ? (
              <External href={photo.authorUrl}>{photo.author}</External>
            ) : (
              photo.author
            )}
          </dd>
          <dt className="text-ink-muted">{text.licence}</dt>
          <dd>
            {photo.licenceUrl ? (
              <External href={photo.licenceUrl} rel="license noreferrer">
                {photo.licence}
              </External>
            ) : (
              photo.licence
            )}
          </dd>
        </dl>
      </div>
    </li>
  );
}

function Body({ load, onRetry }: { load: Load; onRetry: () => void }) {
  const text = useLegalCopy().photos;
  const count = useRef<HTMLParagraphElement>(null);
  const retried = load.state === "ready" && load.retried;
  useEffect(() => {
    const free = document.activeElement === null || document.activeElement === document.body;
    if (retried && free) count.current?.focus({ preventScroll: true });
  }, [retried]);
  if (load.state === "loading") {
    return (
      <p className="type-body text-ink-muted" aria-live="polite">
        {text.creditsLoading}
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="type-body" role="alert">
          {text.creditsError}
        </p>
        <Button
          variant="secondary"
          loading={load.retrying}
          className="aria-disabled:pointer-events-auto"
          onClick={onRetry}
        >
          {text.creditsRetry}
        </Button>
      </div>
    );
  }
  if (load.photos.length === 0) {
    return <p className="type-body text-ink-muted">{text.creditsEmpty}</p>;
  }
  return (
    <>
      <p ref={count} tabIndex={-1} className="num type-data-small text-ink-muted outline-none">
        {text.creditsCount(load.photos.length)}
      </p>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {load.photos.map((photo) => (
          <Credit key={photo.photoId} photo={photo} />
        ))}
      </ul>
    </>
  );
}

/** Every vehicle photo the site shows, with title, author, licence and the Commons file page (WP-6.3). */
export function CreditsPage({ fetcher = fetch }: { fetcher?: Fetcher }) {
  const copy = useLegalCopy();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    loadCredits(fetcher, controller.signal).then(
      (photos) => setLoad({ state: "ready", photos, retried: attempt > 0 }),
      () => {
        if (!controller.signal.aborted) setLoad({ state: "error", retrying: false });
      },
    );
    return () => controller.abort();
  }, [fetcher, attempt]);
  useEffect(() => {
    document.title = `${copy.photos.creditsTitle}, ${copy.brand.name}`;
  }, [copy]);
  return (
    <div className="min-h-dvh bg-background text-ink">
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <LegalHeader current="credits" />
        <div className="flex max-w-[65ch] flex-col gap-2">
          <h1 className="type-headline max-sm:text-[28px]">{copy.photos.creditsTitle}</h1>
          <p className="type-body text-ink-muted">{copy.photos.creditsIntro}</p>
        </div>
        <Body
          load={load}
          onRetry={() => {
            setLoad({ state: "error", retrying: true });
            setAttempt(attempt + 1);
          }}
        />
      </main>
    </div>
  );
}
