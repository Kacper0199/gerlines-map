import { useInViewCopy } from "@gerlines/i18n/inview";
import { useCopy, useLocale } from "@gerlines/i18n/react";
import { BottomSheet, Button, CategoryMark, cn, DelayValue, IconButton } from "@gerlines/ui";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { requestCardFocus } from "../a11y/card-focus.ts";
import { mapCanvas, restoreFocus, slotButton } from "../a11y/focus.ts";
import { useFocusOnOpen } from "../a11y/use-focus-on-open.ts";
import { frameTrainNaming } from "../components/train/train-naming.ts";
import type { NearTrain } from "../motion/protocol.ts";
import { useAppStore } from "../state/store.ts";
import { useSheetHeight } from "../stats/sheet-height.ts";
import { positionText } from "./model.ts";
import { closeInView, useInViewStore } from "./store.ts";

const PEEK_HEIGHT = 168;
/** The list asks again this often while the focus is not on one of its rows, so its distances and delays do not age and the rows do not move under the user. */
export const REFRESH_MS = 20_000;
/** A burst of map moves asks once, after it has settled. */
export const MOVE_DEBOUNCE_MS = 300;

const inViewFocusTarget = () =>
  slotButton("inview-button")() ?? slotButton("layers-button")() ?? mapCanvas();

function useCloseOnEscape(close: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

function TrainRow({ train }: { train: NearTrain }) {
  const copy = useCopy();
  const inview = useInViewCopy();
  const locale = useLocale();
  const centre = useInViewStore((state) => state.answer?.centre);
  const naming = frameTrainNaming(train, copy.train);
  const title = naming.title ?? copy.card.train;
  const minutes = train.delaySeconds === null ? null : Math.round(train.delaySeconds / 60);
  const where = centre === undefined ? "" : positionText(centre, train, inview, locale);
  return (
    <li>
      <button
        type="button"
        data-slot="inview-row"
        onClick={() => {
          requestCardFocus(train.id);
          useAppStore.getState().select(train.id);
        }}
        className="focus-ring flex min-h-target w-full items-center gap-3 rounded-md px-2 text-left hover:bg-raised focus-visible:outline-offset-[-2px]!"
      >
        <CategoryMark category={train.category} size={12} />
        <span className="flex min-w-0 flex-1 flex-col py-1">
          <span className="type-body-strong wrap-break-word">{title}</span>
          <span className="type-caption text-ink-muted">
            {naming.subtitle === null ? "" : `${naming.subtitle}, `}
            {copy.categories[train.category].legend}, {where}
          </span>
        </span>
        <DelayValue minutes={minutes} labels={copy.delay} size="inline" className="shrink-0" />
      </button>
    </li>
  );
}

function List({ phone }: { phone: boolean }) {
  const inview = useInViewCopy();
  const answer = useInViewStore((state) => state.answer);
  const loading = useInViewStore((state) => state.loading);
  const failed = useInViewStore((state) => state.error);
  const headingFocus = useInViewStore((state) => state.headingFocus);
  const refresh = useInViewStore((state) => state.refresh);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnOpen(heading, true);
  useEffect(() => {
    if (headingFocus > 0) heading.current?.focus();
  }, [headingFocus]);
  return (
    <div className={cn("flex flex-col gap-2 px-4 pb-4", !phone && "pt-3")} aria-busy={loading}>
      <h2
        ref={heading}
        data-slot="inview-heading"
        tabIndex={-1}
        className={cn(
          "type-headline wrap-break-word text-[24px] outline-none sm:text-[28px]",
          phone ? "sr-only" : "pr-10",
        )}
      >
        {inview.title}
      </h2>
      <p className="type-body text-ink-muted">{inview.hint}</p>
      <Button variant="secondary" className="self-start" onClick={() => void refresh()}>
        <RefreshCw aria-hidden="true" />
        {inview.update}
      </Button>
      {failed ? (
        <p role="status" className="type-body text-ink">
          {inview.failed}
        </p>
      ) : null}
      {answer === null ? (
        failed ? null : (
          <p role="status" className="type-body text-ink-muted">
            {inview.loading}
          </p>
        )
      ) : answer.result.trains.length === 0 ? (
        <p role="status" className="type-body text-ink-muted">
          {inview.empty}
        </p>
      ) : (
        <ol className="-mx-2 flex flex-col" aria-label={inview.title}>
          {answer.result.trains.map((train) => (
            <TrainRow key={train.key} train={train} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** The trains nearest the middle of the map as a list that opens each train's card: the text path to the map (WCAG 1.1.1). */
export default function InViewPanel({ phone }: { phone: boolean }) {
  const inview = useInViewCopy();
  const refresh = useInViewStore((state) => state.refresh);
  const moves = useInViewStore((state) => state.moves);
  const body = useRef<HTMLDivElement>(null);
  const hasData = useAppStore(
    (state) => state.status.trips > 0 && !["loading", "error"].includes(state.status.state),
  );
  const close = useCallback(() => {
    closeInView();
    restoreFocus(inViewFocusTarget);
  }, []);
  useCloseOnEscape(close);
  useSheetHeight(body, phone);
  useEffect(() => {
    void refresh();
  }, [refresh, hasData]);
  const seenMoves = useRef(moves);
  useEffect(() => {
    if (moves === seenMoves.current) return;
    seenMoves.current = moves;
    const timer = setTimeout(() => void refresh(), MOVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [refresh, moves]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.activeElement?.closest("[data-slot=inview-row]")) void refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  const closeButton = (
    <IconButton label={inview.close} onClick={close}>
      <X aria-hidden="true" />
    </IconButton>
  );
  const content = (
    <div ref={body}>
      <List phone={phone} />
    </div>
  );
  if (phone) {
    return (
      <BottomSheet
        label={inview.title}
        defaultExpanded
        peekHeight={PEEK_HEIGHT}
        expandLabel={inview.expand}
        collapseLabel={inview.collapse}
        collapseOnEscape={false}
        leading={<span className="type-label text-ink-muted">{inview.title}</span>}
        trailing={closeButton}
        className="pointer-events-auto z-20"
      >
        {content}
      </BottomSheet>
    );
  }
  return (
    <article
      aria-label={inview.title}
      className="card-surface card-enter pointer-events-auto flex min-h-0 scroll-pt-12 flex-col overflow-y-auto"
    >
      <div className="pointer-events-none sticky top-1 z-10 -mb-target flex shrink-0 justify-end pr-1 pt-0.5 [&>*]:pointer-events-auto">
        {closeButton}
      </div>
      {content}
    </article>
  );
}
