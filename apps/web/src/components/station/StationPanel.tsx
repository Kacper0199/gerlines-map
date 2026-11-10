import { useCopy } from "@gerlines/i18n/react";
import { Badge, BottomSheet, Button, IconButton, SoonTag } from "@gerlines/ui";
import { Check, Share2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { returnToMap } from "../../a11y/focus.ts";
import { setSheetPeek } from "../../map/view-padding.ts";
import {
  type MissingStation,
  type StationSelection,
  usePlaceStore,
} from "../../state/place-store.ts";
import { loadStation } from "../../url/apply-view.ts";
import { browserApplyStores } from "../../url/store-target.ts";
import type { ShareOutcome } from "../train/card/CardActions.tsx";
import { browserShareTarget, shareLink } from "../train/card/share.ts";

const PHONE_LINES = 8;

function useCloseOnEscape(close: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

function ShareStation({ name }: { name: string }) {
  const copy = useCopy();
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        className="self-start"
        onClick={async () => {
          setOutcome(
            await shareLink(
              window.location.href,
              copy.train.shareTitle(name),
              browserShareTarget(),
            ),
          );
        }}
      >
        {outcome === "copied" ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
        {outcome === "copied" ? copy.train.shareCopied : copy.search.stationShare}
      </Button>
      <p role="status" className={outcome === "failed" ? "type-caption text-ink" : "sr-only"}>
        {outcome === "failed"
          ? copy.train.shareFailed
          : outcome === "copied"
            ? copy.train.shareCopied
            : ""}
      </p>
    </div>
  );
}

/** The phone sheet's height for the attribution above it and the camera padding (as the train sheet). */
function useSheetHeight(body: React.RefObject<HTMLDivElement | null>, phone: boolean): void {
  useLayoutEffect(() => {
    const sheet = body.current?.closest<HTMLElement>("[data-slot=bottom-sheet]");
    if (!(phone && sheet)) return;
    const root = document.documentElement;
    const apply = () => {
      const height = Math.round(sheet.getBoundingClientRect().height);
      setSheetPeek(height);
      root.style.setProperty("--gl-sheet-peek", `${height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(sheet);
    return () => {
      observer.disconnect();
      setSheetPeek(null);
      root.style.removeProperty("--gl-sheet-peek");
    };
  }, [body, phone]);
}

function CardBody({
  phone,
  title,
  subtitle,
  children,
}: {
  phone: boolean;
  title: string;
  subtitle: string | null;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useSheetHeight(body, phone);
  useEffect(() => {
    if (!phone) heading.current?.focus({ preventScroll: true });
  }, [phone]);
  return (
    <div ref={body} className="flex flex-col gap-3 px-4 pb-4">
      <header className="flex flex-col gap-1">
        <h2
          ref={heading}
          tabIndex={-1}
          className="type-headline wrap-break-word text-[24px] outline-none sm:text-[28px]"
        >
          {title}
        </h2>
        {subtitle === null ? null : <p className="type-body text-ink-muted">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

function MissingStationBody({
  missing,
  loading,
  phone,
  retry,
}: {
  missing: MissingStation;
  loading: boolean;
  phone: boolean;
  retry: (id: string) => void;
}) {
  const copy = useCopy();
  if (missing.reason === "not-found") {
    return (
      <CardBody
        phone={phone}
        title={copy.search.stationMissing}
        subtitle={copy.search.stationMissingBody}
      >
        {null}
      </CardBody>
    );
  }
  return (
    <CardBody phone={phone} title={copy.search.stationFailed} subtitle={null}>
      <Button
        variant="secondary"
        className="self-start"
        disabled={loading}
        onClick={() => retry(missing.id)}
      >
        {loading ? copy.search.stationLoading : copy.search.retry}
      </Button>
    </CardBody>
  );
}

function StationBody({ station, phone }: { station: StationSelection; phone: boolean }) {
  const copy = useCopy();
  const shown = phone ? station.lines.slice(0, PHONE_LINES) : station.lines;
  const hidden = station.lines.length - shown.length;
  return (
    <CardBody
      phone={phone}
      title={station.name}
      subtitle={copy.search.trainsToday(station.trainsToday)}
    >
      {station.lines.length > 0 ? (
        <section
          className="flex flex-col gap-2 border-t pt-3"
          aria-label={copy.search.stationLines}
        >
          <h3 className="type-label text-ink-muted">{copy.search.stationLines}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((line) => (
              <li key={line}>
                <Badge variant="outline">{line}</Badge>
              </li>
            ))}
            {hidden > 0 ? (
              <li>
                <Badge variant="muted">{`+${hidden}`}</Badge>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      <section className="flex items-center justify-between gap-2 border-t pt-3">
        <h3 className="type-label text-ink-muted">{copy.train.station.board}</h3>
        <SoonTag label={copy.soon.tag} description={copy.soon.description} />
      </section>
      <div className="border-t pt-3">
        <ShareStation name={station.name} />
      </div>
    </CardBody>
  );
}

function retryFromBrowser(id: string): void {
  loadStation(id, { fly: true }, browserApplyStores());
}

/**
 * The card of a station picked in search or named by a link: name, lines, trains today, Share. A
 * station from a link that did not load says so, with Try again when it may load later.
 */
export function StationPanel({
  phone,
  retry = retryFromBrowser,
}: {
  phone: boolean;
  retry?: (id: string) => void;
}) {
  const copy = useCopy();
  const station = usePlaceStore((state) => state.station);
  const missing = usePlaceStore((state) => state.missingStation);
  const loading = usePlaceStore(
    (state) =>
      state.pendingStationId !== null && state.pendingStationId === state.missingStation?.id,
  );
  const selectStation = usePlaceStore((state) => state.selectStation);
  const close = useCallback(() => {
    selectStation(null);
    returnToMap();
  }, [selectStation]);
  useCloseOnEscape(close);
  if (station === null && missing === null) return null;
  const body =
    station !== null ? (
      <StationBody station={station} phone={phone} />
    ) : missing !== null ? (
      <MissingStationBody missing={missing} loading={loading} phone={phone} retry={retry} />
    ) : null;
  const closeButton = (
    <IconButton label={copy.search.stationClose} onClick={close}>
      <X aria-hidden="true" />
    </IconButton>
  );
  if (phone) {
    return (
      <BottomSheet
        label={copy.train.station.label}
        expandLabel={copy.card.expand}
        collapseLabel={copy.card.collapse}
        expandable={false}
        leading={<span className="type-label text-ink-muted">{copy.train.station.label}</span>}
        trailing={closeButton}
        className="pointer-events-auto z-20"
      >
        {body}
      </BottomSheet>
    );
  }
  return (
    <article
      aria-label={copy.train.station.label}
      className="card-surface card-enter pointer-events-auto flex min-h-0 flex-col overflow-y-auto pt-2"
    >
      <div className="flex min-h-target items-center justify-between gap-2 pl-4 pr-1">
        <span className="type-label text-ink-muted">{copy.train.station.label}</span>
        {closeButton}
      </div>
      {body}
    </article>
  );
}
