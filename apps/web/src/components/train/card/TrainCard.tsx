import { useCopy } from "@gerlines/i18n/react";
import type { TrainDetail } from "@gerlines/schema";
import {
  BottomSheet,
  Button,
  cn,
  IconButton,
  Notice,
  SHEET_PEEK_HEIGHT,
  useSheetState,
} from "@gerlines/ui";
import { ChevronDown, CircleSlash, X } from "lucide-react";
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { setSheetPeek } from "../../../map/view-padding.ts";
import { ProfileHost } from "../../../profile/ProfileHost.tsx";
import { ForecastBlock } from "../forecast/ForecastBlock.tsx";
import { buildCardModel, type Freshness, type StopRow, type TrainCardModel } from "../model.ts";
import { SelectedSpeed } from "../SpeedRow.tsx";
import { CardActions, type TrainActionHandlers } from "./CardActions.tsx";
import { CardHead, CategoryBadge, trainTitle } from "./CardHead.tsx";
import { CardLoading, CardMessage } from "./CardStates.tsx";
import { Provenance } from "./Provenance.tsx";
import { StationCard } from "./StationCard.tsx";
import { StopStrip } from "./StopStrip.tsx";
import { StuckTitle, useScrolledAway } from "./StuckTitle.tsx";
import { VehicleBlock, VehicleSummary } from "./VehicleBlock.tsx";

export type TrainCardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly detail: TrainDetail; readonly freshness?: Freshness }
  | { readonly status: "not-found" }
  | { readonly status: "error"; readonly retry?: () => void };

export interface TrainCardProps {
  readonly state: TrainCardState;
  readonly nowMs: number;
  readonly handlers: TrainActionHandlers;
  readonly onClose: () => void;
  readonly defaultStopsOpen?: boolean;
  readonly defaultStationIndex?: number;
}

const ProfileBlock = lazy(() => import("../../../profile/ProfileBlock.tsx"));

const SHEET_HEAD_HEIGHT = 44;
const CURRENT_ROW = "[data-slot=between], [data-role=headline]";

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function revealCurrentRow(container: HTMLElement | null): void {
  const row = container?.querySelector<HTMLElement>(CURRENT_ROW);
  if (!row || typeof row.scrollIntoView !== "function") {
    return;
  }
  row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function focusStop(container: HTMLElement | null, index: number | null): void {
  if (index === null) {
    return;
  }
  const button = container?.querySelector<HTMLElement>(`[data-stop-index="${index}"]`);
  button?.focus();
  if (button && typeof button.scrollIntoView === "function") {
    button.scrollIntoView({ block: "nearest" });
  }
}

function useMeasuredHeight(onHeight: (height: number) => void) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node) {
        return;
      }
      onHeight(node.offsetHeight);
      if (typeof ResizeObserver === "function") {
        observer.current = new ResizeObserver(() => onHeight(node.offsetHeight));
        observer.current.observe(node);
      }
    },
    [onHeight],
  );
}

function ProfileSlot({ model }: { model: TrainCardModel }) {
  return model.profile ? (
    <Suspense fallback={null}>
      <ProfileBlock subject={model.profile} />
    </Suspense>
  ) : null;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const copy = useCopy();
  return (
    <IconButton label={copy.card.close} onClick={onClose}>
      <X aria-hidden="true" />
    </IconButton>
  );
}

function StopsToggle({
  open,
  count,
  controls,
  onToggle,
}: {
  open: boolean;
  count: number;
  controls: string;
  onToggle: () => void;
}) {
  const train = useCopy().train;
  return (
    <div
      className={cn(
        "px-4 pl-[52px]",
        open && "sticky -bottom-4 z-20 -my-3 bg-surface py-3 shadow-[0_-1px_0_var(--gl-hairline)]",
      )}
    >
      <Button
        variant="quiet"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
        className="-ml-3 text-ink"
      >
        {open ? train.fewerStops : train.allStops(count)}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "transition-transform duration-(--gl-duration-panel)",
            open && "rotate-180",
          )}
        />
      </Button>
    </div>
  );
}

function CancelledNotice() {
  const train = useCopy().train;
  return (
    <div className="px-4">
      <Notice tone="error" icon={<CircleSlash />}>
        {train.cancelledNote}
      </Notice>
    </div>
  );
}

function useStation(model: TrainCardModel | null, defaultIndex: number | undefined) {
  const [index, setIndex] = useState<number | null>(defaultIndex ?? null);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const station = model?.stops.find((stop) => stop.index === index) ?? null;
  return {
    station,
    returnTo,
    open: (stop: StopRow) => {
      setReturnTo(null);
      setIndex(stop.index);
    },
    close: () => {
      setReturnTo(index);
      setIndex(null);
    },
  };
}

function useModel(state: TrainCardState, nowMs: number): TrainCardModel | null {
  const detail = state.status === "ready" ? state.detail : null;
  const freshness = state.status === "ready" ? state.freshness : undefined;
  return useMemo(
    () => (detail ? buildCardModel(detail, nowMs, freshness) : null),
    [detail, nowMs, freshness],
  );
}

function useReturnFocus(container: RefObject<HTMLElement | null>, returnTo: number | null): void {
  useEffect(() => {
    focusStop(container.current, returnTo);
  }, [container, returnTo]);
}

function PanelBody({
  model,
  nowMs,
  handlers,
  close,
  stopsOpen,
  onStopsOpen,
  onStation,
  returnTo,
  headingId,
}: {
  model: TrainCardModel;
  nowMs: number;
  handlers: TrainActionHandlers;
  close: ReactNode;
  stopsOpen: boolean;
  onStopsOpen: (open: boolean) => void;
  onStation: (stop: StopRow) => void;
  returnTo: number | null;
  headingId: string;
}) {
  const stripId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const revealOnOpen = useRef(false);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const headScrolledAway = useScrolledAway(head);
  useReturnFocus(scroller, returnTo);
  useEffect(() => {
    if (stopsOpen && revealOnOpen.current) {
      revealOnOpen.current = false;
      revealCurrentRow(scroller.current);
    }
  }, [stopsOpen]);
  return (
    <>
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 scroll-pt-12 scroll-pb-16 flex-col gap-3 overflow-y-auto overscroll-contain pb-4"
      >
        <div ref={setHead}>
          <CardHead model={model} peek={false} closeSlot={close} headingId={headingId} />
        </div>
        {headScrolledAway ? (
          <StuckTitle
            model={model}
            closeSlot={close}
            onLeaveWithFocus={() => head?.querySelector("button")?.focus({ preventScroll: true })}
          />
        ) : null}
        {model.cancelled ? <CancelledNotice /> : null}
        <StopStrip
          id={stripId}
          model={model}
          nowMs={nowMs}
          mode={stopsOpen ? "all" : "focus"}
          compact={false}
          onStopSelect={onStation}
        />
        <StopsToggle
          open={stopsOpen}
          count={model.stops.length}
          controls={stripId}
          onToggle={() => {
            revealOnOpen.current = !stopsOpen;
            onStopsOpen(!stopsOpen);
          }}
        />
        {stopsOpen ? (
          <VehicleBlock vehicle={model.vehicle} photo={model.photo} wide />
        ) : model.vehicle ? (
          <VehicleSummary vehicle={model.vehicle} />
        ) : null}
        {stopsOpen && model.forecast ? <ForecastBlock forecast={model.forecast} /> : null}
        <ProfileSlot model={model} />
        <SelectedSpeed />
        <Provenance model={model} />
      </div>
      <CardActions
        onMap={model.onMap}
        handlers={handlers}
        className="shrink-0 border-t pt-3 pb-4"
      />
    </>
  );
}

export function TrainPanel({
  state,
  nowMs,
  handlers,
  onClose,
  defaultStopsOpen = false,
  defaultStationIndex,
}: TrainCardProps) {
  const copy = useCopy();
  const model = useModel(state, nowMs);
  const { station, returnTo, open, close } = useStation(model, defaultStationIndex);
  const [stopsOpen, setStopsOpen] = useState(defaultStopsOpen);
  const headingId = useId();
  const closeSlot = (
    <div className="-mr-3">
      <CloseButton onClose={onClose} />
    </div>
  );
  let body: ReactNode;
  if (state.status === "loading") {
    body = <CardLoading closeSlot={closeSlot} peek={false} />;
  } else if (state.status === "not-found" || state.status === "error") {
    body = (
      <CardMessage
        closeSlot={closeSlot}
        kind={state.status}
        {...(state.status === "error" && state.retry ? { onRetry: state.retry } : {})}
      />
    );
  } else if (model && station) {
    body = (
      <div className="min-h-0 overflow-y-auto">
        <StationCard
          stop={station}
          trainName={trainTitle(model, copy.train, copy.card.train)}
          onBack={close}
          closeSlot={closeSlot}
          headingId={headingId}
        />
      </div>
    );
  } else if (model) {
    body = (
      <PanelBody
        model={model}
        nowMs={nowMs}
        handlers={handlers}
        close={closeSlot}
        stopsOpen={stopsOpen}
        onStopsOpen={setStopsOpen}
        onStation={open}
        returnTo={returnTo}
        headingId={headingId}
      />
    );
  }
  return (
    <article
      aria-label={state.status === "ready" ? undefined : copy.card.label}
      aria-labelledby={state.status === "ready" ? headingId : undefined}
      className="card-surface card-enter pointer-events-auto flex min-h-0 flex-col pt-2"
    >
      {body}
      <ProfileHost subject={model?.profile ?? null} />
    </article>
  );
}

function SheetContent({
  model,
  nowMs,
  handlers,
  onStation,
  returnTo,
  headingId,
  onPeekSize,
  badgeInHead,
}: {
  model: TrainCardModel;
  nowMs: number;
  handlers: TrainActionHandlers;
  onStation: (stop: StopRow) => void;
  returnTo: number | null;
  headingId: string;
  onPeekSize: (height: number) => void;
  badgeInHead: boolean;
}) {
  const peek = useSheetState() === "peek";
  const measured = useMeasuredHeight(onPeekSize);
  const expanded = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const headScrolledAway = useScrolledAway(head);
  useReturnFocus(expanded, returnTo);
  useEffect(() => {
    if (peek || returnTo !== null) {
      return;
    }
    const timer = window.setTimeout(
      () => revealCurrentRow(expanded.current),
      prefersReducedMotion() ? 0 : 240,
    );
    return () => window.clearTimeout(timer);
  }, [peek, returnTo]);
  if (peek) {
    return (
      <div ref={measured} className="flex flex-col pb-3">
        <CardHead
          model={model}
          peek
          closeSlot={null}
          showBadge={!badgeInHead}
          headingId={headingId}
        />
        {model.cancelled ? null : (
          <StopStrip model={model} nowMs={nowMs} mode="focus" compact onStopSelect={onStation} />
        )}
        {model.cancelled ? (
          <div className="mt-3">
            <CancelledNotice />
          </div>
        ) : null}
        <CardActions onMap={model.onMap} handlers={handlers} className="mt-3" />
      </div>
    );
  }
  return (
    <div ref={expanded} className="flex flex-col gap-3">
      <div ref={setHead}>
        <CardHead
          model={model}
          peek={false}
          closeSlot={null}
          showBadge={!badgeInHead}
          headingId={headingId}
        />
      </div>
      {headScrolledAway ? <StuckTitle model={model} /> : null}
      {model.cancelled ? <CancelledNotice /> : null}
      <StopStrip model={model} nowMs={nowMs} mode="all" compact={false} onStopSelect={onStation} />
      <VehicleBlock vehicle={model.vehicle} photo={model.photo} wide />
      {model.forecast ? <ForecastBlock forecast={model.forecast} /> : null}
      <ProfileSlot model={model} />
      <SelectedSpeed />
      <Provenance model={model} />
      <CardActions
        onMap={model.onMap}
        handlers={handlers}
        className="sticky bottom-0 z-20 border-t bg-surface pt-3 pb-3"
      />
    </div>
  );
}

function SheetBadgeSlot({
  model,
  onPlacement,
}: {
  model: TrainCardModel;
  onPlacement: (inHead: boolean) => void;
}) {
  const [inHead, setInHead] = useState(true);
  const slot = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = slot.current;
    const content = badge.current;
    if (!frame || !content) {
      return;
    }
    let live = true;
    const measure = () => {
      if (!live) {
        return;
      }
      const fits = content.scrollWidth <= frame.clientWidth;
      setInHead(fits);
      onPlacement(fits);
    };
    measure();
    void document.fonts?.ready.then(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(frame);
    observer?.observe(content);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [onPlacement]);
  return (
    <div ref={slot} className="relative flex w-full min-w-0 items-center">
      <div
        ref={badge}
        aria-hidden={inHead ? undefined : true}
        className={inHead ? "min-w-0 overflow-hidden" : "invisible absolute left-0 w-max"}
      >
        <CategoryBadge model={model} />
      </div>
    </div>
  );
}

function usePeekHeight(): [number, (contentHeight: number) => void] {
  const [contentHeight, setContentHeight] = useState(0);
  const peekHeight = Math.max(SHEET_PEEK_HEIGHT, contentHeight + SHEET_HEAD_HEIGHT);
  useLayoutEffect(() => {
    setSheetPeek(peekHeight);
    document.documentElement.style.setProperty("--gl-sheet-peek", `${peekHeight}px`);
  }, [peekHeight]);
  useLayoutEffect(
    () => () => {
      setSheetPeek(null);
      document.documentElement.style.removeProperty("--gl-sheet-peek");
    },
    [],
  );
  return [peekHeight, setContentHeight];
}

export function TrainSheet({
  state,
  nowMs,
  handlers,
  onClose,
  defaultStationIndex,
  defaultExpanded = false,
}: TrainCardProps & { defaultExpanded?: boolean }) {
  const copy = useCopy();
  const model = useModel(state, nowMs);
  const { station, returnTo, open, close } = useStation(model, defaultStationIndex);
  const [expanded, setExpanded] = useState(defaultExpanded || defaultStationIndex !== undefined);
  const headingId = useId();
  const [peekHeight, setContentHeight] = usePeekHeight();
  const [badgeInHead, onBadgePlacement] = useState(true);
  let body: ReactNode;
  if (state.status === "loading") {
    body = <CardLoading closeSlot={null} peek />;
  } else if (state.status === "not-found" || state.status === "error") {
    body = (
      <CardMessage
        closeSlot={null}
        kind={state.status}
        {...(state.status === "error" && state.retry ? { onRetry: state.retry } : {})}
      />
    );
  } else if (model && station) {
    body = (
      <StationCard
        stop={station}
        trainName={trainTitle(model, copy.train, copy.card.train)}
        onBack={close}
        closeSlot={null}
        headingId={headingId}
      />
    );
  } else if (model) {
    body = (
      <SheetContent
        model={model}
        nowMs={nowMs}
        handlers={handlers}
        onStation={(stop) => {
          setExpanded(true);
          open(stop);
        }}
        returnTo={returnTo}
        headingId={headingId}
        onPeekSize={setContentHeight}
        badgeInHead={badgeInHead}
      />
    );
  }
  return (
    <BottomSheet
      peekHeight={peekHeight}
      leading={
        model && !station ? <SheetBadgeSlot model={model} onPlacement={onBadgePlacement} /> : null
      }
      label={copy.card.label}
      expandLabel={copy.card.expand}
      collapseLabel={copy.card.collapse}
      expanded={expanded}
      expandedFit="content"
      onExpandedChange={setExpanded}
      trailing={<CloseButton onClose={onClose} />}
      className="pointer-events-auto z-20"
    >
      {body}
      <ProfileHost subject={model?.profile ?? null} />
    </BottomSheet>
  );
}
