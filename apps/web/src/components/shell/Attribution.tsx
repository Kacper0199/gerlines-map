import { useCopy } from "@gerlines/i18n/react";
import { cn, IconButton } from "@gerlines/ui";
import { Info, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CREDITS_PATH } from "../../credits/path.ts";
import { IMPRINT_PATH, PRIVACY_PATH, SOURCES_PATH, withLanguage } from "../../legal/path.ts";
import type { MapStyleKind } from "../../map/style/map-styles.ts";
import { useAppStore } from "../../state/store.ts";

const BKG_SOURCE_NOTE = "© GeoBasis-DE / BKG (2026)";
const BKG_LICENCE = "DL-DE BY 2.0";
const LICENCE_BY = { name: "CC BY 4.0", href: "https://creativecommons.org/licenses/by/4.0/" };
const LICENCE_BY_SA = {
  name: "CC BY-SA 4.0",
  href: "https://creativecommons.org/licenses/by-sa/4.0/",
};
const VERSATILES = "VersaTiles";
const STADA_HREF = "https://developers.deutschebahn.com/db-api-marketplace/apis/product/stada";
const MAPTERHORN = "© Mapterhorn";
export const ATTRIBUTION_AUTO_COLLAPSE_MS = 5000;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="whitespace-nowrap text-ink underline underline-offset-2"
    >
      {children}
    </a>
  );
}

function InternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={withLanguage(href)}
      className="whitespace-nowrap text-ink underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** What each licence covers: the timetable is CC BY 4.0, the realtime data CC BY-SA 4.0 (docs/data-sources.md). */
function DelfiLicences() {
  const text = useCopy().attribution;
  return (
    <>
      {" ("}
      {text.timetable} <ExternalLink href={LICENCE_BY.href}>{LICENCE_BY.name}</ExternalLink>,{" "}
      {text.realtime} <ExternalLink href={LICENCE_BY_SA.href}>{LICENCE_BY_SA.name}</ExternalLink>
      {")"}
    </>
  );
}

function TrainSources() {
  const text = useCopy().attribution;
  return (
    <>
      <ExternalLink href="https://www.delfi.de">{text.delfi}</ExternalLink>,{" "}
      <ExternalLink href="https://gtfs.de">{text.gtfsDe}</ExternalLink>
      <DelfiLicences />
    </>
  );
}

function StyleSources({ style }: { style: MapStyleKind }) {
  const text = useCopy().attribution;
  if (style === "satellite") {
    return (
      <>
        {" "}
        {text.imagery}{" "}
        <ExternalLink href="https://versatiles.org/sources/">{VERSATILES}</ExternalLink>,{" "}
        {text.imageryProviders}.
      </>
    );
  }
  if (style === "terrain") {
    return (
      <>
        {" "}
        {text.elevation}{" "}
        <ExternalLink href="https://mapterhorn.com/attribution/">{MAPTERHORN}</ExternalLink>.
      </>
    );
  }
  return null;
}

export function AttributionText({ className }: { className?: string }) {
  const { attribution: text, photos, legal } = useCopy();
  const style = useAppStore((state) => state.mapStyle);
  return (
    <p className={cn("text-[11px] leading-[1.45] text-ink-muted", className)}>
      {text.mapData}{" "}
      <ExternalLink href="https://www.openstreetmap.org/copyright">
        {text.openStreetMap}
      </ExternalLink>
      , <ExternalLink href="https://openfreemap.org">{text.openFreeMap}</ExternalLink>,{" "}
      <ExternalLink href="https://openmaptiles.org">{text.openMapTiles}</ExternalLink>.
      <StyleSources style={style} /> {text.trains} <TrainSources />. {text.stationNames}{" "}
      <ExternalLink href={STADA_HREF}>{text.dbStada}</ExternalLink>
      {" ("}
      <ExternalLink href={LICENCE_BY.href}>{LICENCE_BY.name}</ExternalLink>
      {"). "}
      {text.borders} <ExternalLink href="https://www.bkg.bund.de">{BKG_SOURCE_NOTE}</ExternalLink>,{" "}
      <ExternalLink href="https://www.govdata.de/dl-de/by-2-0">{BKG_LICENCE}</ExternalLink>,{" "}
      {text.licenceChanged},{" "}
      <ExternalLink href="https://www.naturalearthdata.com">{text.naturalEarth}</ExternalLink>.{" "}
      <InternalLink href={CREDITS_PATH}>{photos.creditsLink}</InternalLink>,{" "}
      <InternalLink href={SOURCES_PATH}>{legal.sourcesLink}</InternalLink>,{" "}
      <InternalLink href={PRIVACY_PATH}>{legal.privacyLink}</InternalLink>,{" "}
      <InternalLink href={IMPRINT_PATH}>{legal.imprintLink}</InternalLink>.{" "}
      {legal.notAffiliatedShort}
    </p>
  );
}

export function Attribution({
  collapsible: collapsibleByScreen = false,
  fold = false,
  className,
}: {
  collapsible?: boolean;
  /** True while a panel needs the room of the card: the credits fold to the info button at once. */
  fold?: boolean;
  className?: string;
}) {
  const copy = useCopy();
  const [open, setOpen] = useState(true);
  const [settled, setSettled] = useState(false);
  const interacted = useAppStore((state) => state.mapInteracted);
  const root = useRef<HTMLElement>(null);
  const panelId = useId();
  const collapsible = collapsibleByScreen || fold;
  const expanded = !collapsible || open;

  const heldByFocus = useRef(false);
  useEffect(() => {
    if (!fold) {
      heldByFocus.current = false;
      return;
    }
    if (root.current?.contains(document.activeElement)) {
      heldByFocus.current = true;
      return;
    }
    setSettled(true);
    setOpen(false);
  }, [fold]);

  useEffect(() => {
    if (!collapsible || settled) {
      return;
    }
    const collapse = () => {
      setSettled(true);
      if (!root.current?.contains(document.activeElement)) {
        setOpen(false);
      }
    };
    if (interacted) {
      collapse();
      return;
    }
    const timer = window.setTimeout(collapse, ATTRIBUTION_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [collapsible, interacted, settled]);

  return (
    <aside
      ref={root}
      aria-label={copy.attribution.label}
      className={cn("pointer-events-auto flex flex-col items-end gap-2", className)}
      onBlur={(event) => {
        if (!heldByFocus.current || root.current?.contains(event.relatedTarget)) return;
        heldByFocus.current = false;
        setSettled(true);
        setOpen(false);
      }}
    >
      <div
        id={panelId}
        hidden={!expanded}
        className="card-surface w-[min(330px,100%)] max-w-[330px] px-3 py-2"
      >
        <AttributionText />
      </div>
      {collapsible ? (
        <IconButton
          variant="secondary"
          label={open ? copy.attribution.hide : copy.attribution.show}
          aria-expanded={open}
          aria-controls={panelId}
          className="card-surface"
          onClick={() => {
            heldByFocus.current = false;
            setSettled(true);
            setOpen(!open);
          }}
        >
          {open ? <X aria-hidden="true" /> : <Info aria-hidden="true" />}
        </IconButton>
      ) : null}
    </aside>
  );
}
