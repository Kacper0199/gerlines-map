import { useJourneysCopy } from "@gerlines/i18n/journeys";
import { BottomSheet, IconButton } from "@gerlines/ui";
import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { setSheetPeek } from "../map/view-padding.ts";
import { usePanelOpen } from "../state/panel-store.ts";
import { JourneyResults, JourneyRow } from "./JourneyList.tsx";
import { PlannerForm } from "./PlannerForm.tsx";
import { PLANNER_SHEET_PEEK, selectedJourney, usePlannerStore } from "./planner-store.ts";

function useCloseOnEscape(close: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, active]);
}

/** The head label, as the statistics card names itself in the same slot. */
function Title() {
  const copy = useJourneysCopy();
  return <h2 className="type-label truncate text-ink-muted">{copy.journeys.title}</h2>;
}

/** Closes the planner and gives the focus back to the button that opened it. */
function useClose(): () => void {
  const close = usePlannerStore((state) => state.closePlanner);
  return useCallback(() => {
    close();
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-slot=planner-button]")?.focus(),
    );
  }, [close]);
}

function CloseButton() {
  const copy = useJourneysCopy();
  const close = useClose();
  return (
    <IconButton label={copy.journeys.close} onClick={close}>
      <X aria-hidden="true" />
    </IconButton>
  );
}

/** The sheet's height for the attribution above it and the camera padding, as the train sheet. */
function useSheetHeight(body: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const sheet = body.current?.closest<HTMLElement>("[data-slot=bottom-sheet]");
    if (!sheet) return;
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
  }, [body]);
}

function PhonePlanner() {
  const copy = useJourneysCopy();
  const journey = usePlannerStore(selectedJourney);
  const selectedId = usePlannerStore((state) => state.selectedId);
  const close = useClose();
  const [expanded, setExpanded] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const picked = useRef<string | null>(null);
  useSheetHeight(body);
  useCloseOnEscape(close, !expanded);
  useEffect(() => {
    if (selectedId !== null && picked.current !== null && selectedId !== picked.current) {
      setExpanded(false);
    }
    picked.current = selectedId;
  }, [selectedId]);
  const peek = !expanded && journey !== null;
  return (
    <BottomSheet
      label={copy.journeys.title}
      expandLabel={copy.journeys.back}
      collapseLabel={copy.journeys.show}
      expanded={expanded || journey === null}
      onExpandedChange={setExpanded}
      peekHeight={PLANNER_SHEET_PEEK}
      leading={<Title />}
      trailing={<CloseButton />}
      className="pointer-events-auto z-20"
    >
      <div ref={body} data-slot="planner-panel" className="flex flex-col gap-3 pb-4">
        {peek && journey ? (
          <JourneyRow journey={journey} selected onSelect={() => setExpanded(true)} />
        ) : (
          <>
            <PlannerForm />
            <JourneyResults />
          </>
        )}
      </div>
    </BottomSheet>
  );
}

function DesktopPlanner() {
  const copy = useJourneysCopy();
  const close = useClose();
  useCloseOnEscape(close, true);
  return (
    <article
      aria-label={copy.journeys.title}
      data-slot="planner-panel"
      className="card-surface card-enter pointer-events-auto flex min-h-0 flex-col overflow-hidden"
    >
      <div
        data-slot="planner-head"
        className="flex min-h-target shrink-0 items-center justify-between gap-2 border-b bg-surface pt-2 pr-1 pl-4"
      >
        <Title />
        <CloseButton />
      </div>
      <div
        data-slot="planner-scroll"
        className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain pt-3"
      >
        <PlannerForm />
        <JourneyResults />
      </div>
    </article>
  );
}

/**
 * The journey planner: a card under the search card on desktop and tablet, a bottom sheet on phone
 * that drops to the chosen journey once one is picked, so its route shows on the map.
 */
export function PlannerPanel({ phone }: { phone: boolean }) {
  const open = usePanelOpen("journeys");
  if (!open) return null;
  return phone ? <PhonePlanner /> : <DesktopPlanner />;
}
