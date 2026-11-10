import type { Locale } from "@gerlines/i18n";
import { useJourneysCopy } from "@gerlines/i18n/journeys";
import { useFormatters, useLocale } from "@gerlines/i18n/react";
import type { Journey, JourneyLeg, TransitLeg } from "@gerlines/schema/journeys";
import { Button, CategoryMark, cn, DelayChip, Notice, Skeleton, TimePair } from "@gerlines/ui";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Footprints,
  TrainFront,
} from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { requestCardFocus } from "../a11y/card-focus.ts";
import { useNow } from "../hooks/use-now.ts";
import { usePlaybackStore } from "../playback/store.ts";
import { categoryKeyOf } from "../search/result-view.ts";
import { usePlaceStore } from "../state/place-store.ts";
import { useAppStore } from "../state/store.ts";
import {
  formatChanges,
  formatDay,
  formatDuration,
  formatShare,
  type JourneysCopy,
} from "./format.ts";
import {
  type DetailItem,
  delayMinutes,
  detailItems,
  journeyReliability,
  legName,
  liveRunOf,
  type ReliabilityEntry,
  transitLegs,
} from "./journey-view.ts";
import type { JourneyError } from "./journeys-client.ts";
import { type ResultsState, usePlannerStore } from "./planner-store.ts";
import { PLANNER_CATEGORIES } from "./planner-url.ts";
import { resultsScrollTop } from "./results-scroll.ts";

type Clock = (ms: number) => string;

const LIVE_CHECK_MS = 30_000;

function legKey(leg: JourneyLeg): string {
  return `${leg.kind}|${leg.departure}|${leg.from.stopId ?? leg.from.name}`;
}

function useLegName(leg: TransitLeg) {
  const copy = useJourneysCopy();
  return legName(leg, copy.journeys, copy.categories[categoryKeyOf(leg.category)].badge);
}

function Time({
  time,
  scheduled,
  clock,
  label,
}: {
  time: string;
  scheduled: string | null;
  clock: Clock;
  label?: string;
}) {
  return (
    <span className="flex">
      {label ? <span className="sr-only">{label}</span> : null}
      <TimePair
        predicted={clock(Date.parse(time))}
        scheduled={scheduled ? clock(Date.parse(scheduled)) : undefined}
        className="items-start"
      />
    </span>
  );
}

/** Numbers in the mono face, words in the text face (DESIGN.md delay slot rule). */
function MixedText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {text.split(/(\d+)/).map((part, index) =>
        /^\d+$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
          <span key={index} className="num">
            {part}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </span>
  );
}

function LegChip({ leg }: { leg: TransitLeg }) {
  const name = useLegName(leg);
  return (
    <span className="inline-flex items-center gap-1.5">
      <CategoryMark category={categoryKeyOf(leg.category)} size={10} />
      <span className={cn("type-label text-ink", leg.cancelled && "text-ink-muted line-through")}>
        {name.title}
      </span>
    </span>
  );
}

function LegChain({ journey }: { journey: Journey }) {
  const legs = transitLegs(journey);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {legs.map((leg, index) => (
        <span key={legKey(leg)} className="inline-flex items-center gap-1.5">
          {index > 0 ? (
            <ChevronRight aria-hidden="true" className="size-3.5 text-ink-muted" />
          ) : null}
          <LegChip leg={leg} />
        </span>
      ))}
    </span>
  );
}

/** The punctuality hint as lines: the rating or why there is none, then what it leaves out. */
function reliabilityLines(
  journey: Journey,
  entries: ReadonlyMap<string, ReliabilityEntry>,
  copy: JourneysCopy,
  locale: Locale,
  nameOf: (leg: TransitLeg) => string,
): string[] {
  const hint = journeyReliability(journey, entries);
  if (hint.kind === "loading") return [copy.reliability.loading];
  if (hint.kind === "missing") return [copy.reliability.missing[hint.reason]];
  const partial = hint.missing > 0 ? [copy.reliability.partial(hint.missing)] : [];
  if (hint.kind === "thin") {
    const thin = copy.reliability.thin(hint.runs);
    return [hint.leg ? `${nameOf(hint.leg)}, ${thin}` : thin, ...partial];
  }
  const share = formatShare(locale, hint.share);
  const day = hint.firstDay === null ? null : formatDay(locale, hint.firstDay);
  const head = hint.weakest
    ? copy.reliability.train(nameOf(hint.weakest), share, day)
    : copy.reliability.share(share, day);
  const unrated = hint.unrated > 0 ? [copy.reliability.unrated(hint.unrated)] : [];
  return [`${head}, ${copy.reliability.runs(hint.runs)}`, ...unrated, ...partial];
}

function ReliabilityLine({ journey }: { journey: Journey }) {
  const copy = useJourneysCopy();
  const locale = useLocale();
  const entries = usePlannerStore((state) => state.reliability);
  const nameOf = (leg: TransitLeg) =>
    legName(leg, copy.journeys, copy.categories[categoryKeyOf(leg.category)].badge).title;
  const lines = reliabilityLines(journey, entries, copy.journeys, locale, nameOf);
  return (
    <span data-slot="journey-reliability" className="flex flex-col">
      {lines.map((line) => (
        <span key={line} className="type-caption wrap-break-word text-ink-muted">
          {line}
        </span>
      ))}
    </span>
  );
}

function tagsOf(journey: Journey, copy: JourneysCopy): string[] {
  const tags: string[] = [];
  if (journey.tags.includes("fastest")) tags.push(copy.tags.fastest);
  if (journey.tags.includes("fewestChanges") && journey.transfers > 0)
    tags.push(copy.tags.fewestChanges);
  return tags;
}

function JourneyRow({
  journey,
  selected,
  onSelect,
}: {
  journey: Journey;
  selected: boolean;
  onSelect: () => void;
}) {
  const copy = useJourneysCopy();
  const { clock } = useFormatters();
  const first = journey.legs[0];
  const last = journey.legs.at(-1);
  const tags = tagsOf(journey, copy.journeys);
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-slot="journey-row"
      onClick={onSelect}
      className={cn(
        "focus-ring flex w-full scroll-mt-2 flex-col gap-1.5 border-l-2 border-transparent px-4 py-3 text-left transition-colors hover:bg-raised focus-visible:outline-offset-[-2px]!",
        selected && "border-ink bg-raised",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex items-start gap-2">
          <Time
            time={journey.departure}
            scheduled={first?.kind === "transit" ? first.scheduledDeparture : null}
            clock={clock}
            label={copy.journeys.departure}
          />
          <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <Time
            time={journey.arrival}
            scheduled={last?.kind === "transit" ? last.scheduledArrival : null}
            clock={clock}
            label={copy.journeys.arrival}
          />
        </span>
        <span className="flex flex-col items-end gap-0.5 text-right">
          <MixedText
            text={formatDuration(copy.journeys, journey.durationS)}
            className="type-label text-ink"
          />
          <span className="type-caption text-ink-muted">
            {formatChanges(copy.journeys, journey.transfers)}
          </span>
        </span>
      </span>
      <LegChain journey={journey} />
      <ReliabilityLine journey={journey} />
      {tags.length > 0 ? <span className="type-caption text-ink">{tags.join(", ")}</span> : null}
    </button>
  );
}

function trackText(
  copy: ReturnType<typeof useJourneysCopy>,
  track: string | null,
  scheduledTrack: string | null,
): string | null {
  if (!track) return null;
  return track !== scheduledTrack && scheduledTrack
    ? copy.card.platformChanged(track, scheduledTrack)
    : copy.journeys.platform(track);
}

function StopLine({
  name,
  time,
  scheduled,
  track,
  scheduledTrack,
  cancelled,
  label,
}: {
  name: string;
  time: string;
  scheduled: string | null;
  track: string | null;
  scheduledTrack: string | null;
  cancelled: boolean;
  label: string;
}) {
  const copy = useJourneysCopy();
  const { clock } = useFormatters();
  const platform = trackText(copy, track, scheduledTrack);
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-3">
      <Time time={time} scheduled={scheduled} clock={clock} label={label} />
      <div className="flex flex-col">
        <span
          className={cn(
            "type-body-strong wrap-break-word",
            cancelled && "text-ink-muted line-through",
          )}
        >
          {name}
        </span>
        {platform ? <span className="type-caption text-ink-muted">{platform}</span> : null}
      </div>
    </div>
  );
}

/** Opens the live train card of a leg whose train runs now; none in a playback of a past hour. */
function LiveTrainLink({ leg }: { leg: TransitLeg }) {
  const copy = useJourneysCopy();
  const run = liveRunOf(leg, useNow(LIVE_CHECK_MS));
  const playback = usePlaybackStore((store) => store.state !== null);
  if (run === null || playback) return null;
  return (
    <Button
      variant="quiet"
      className="-ml-3 self-start"
      onClick={() => {
        usePlaceStore.getState().selectStation(null);
        requestCardFocus(run.tripInstanceId);
        useAppStore.getState().select(run.tripInstanceId);
      }}
    >
      <TrainFront aria-hidden="true" />
      {copy.journeys.liveTrain}
    </Button>
  );
}

function TransitDetail({ leg, from, to }: { leg: TransitLeg; from: boolean; to: boolean }) {
  const copy = useJourneysCopy();
  const name = useLegName(leg);
  const late = delayMinutes(leg.departure, leg.scheduledDeparture);
  const facts = [name.detail, leg.operator].filter((fact): fact is string => Boolean(fact));
  return (
    <li
      className="flex flex-col gap-2 border-l-2 py-1 pl-3"
      style={{ borderColor: "var(--gl-hairline)" }}
    >
      {from ? (
        <StopLine
          name={leg.from.name}
          time={leg.departure}
          scheduled={leg.scheduledDeparture}
          track={leg.from.track}
          scheduledTrack={leg.from.scheduledTrack}
          cancelled={leg.from.cancelled}
          label={copy.journeys.departure}
        />
      ) : null}
      <div className="flex flex-col gap-0.5 pl-[4.0rem]">
        <span className="inline-flex flex-wrap items-center gap-2">
          <LegChip leg={leg} />
          {leg.headsign ? (
            <span className="type-caption text-ink-muted">
              {copy.journeys.towards(leg.headsign)}
            </span>
          ) : null}
          <DelayChip minutes={late} label={copy.train.delay} />
        </span>
        {facts.length > 0 ? (
          <span className="type-caption wrap-break-word text-ink-muted">{facts.join(", ")}</span>
        ) : null}
        <MixedText
          className="type-caption text-ink-muted"
          text={
            leg.cancelled
              ? copy.journeys.cancelled
              : leg.realtime
                ? formatDuration(copy.journeys, leg.durationS)
                : `${formatDuration(copy.journeys, leg.durationS)}, ${copy.journeys.timetableOnly}`
          }
        />
        <LiveTrainLink leg={leg} />
      </div>
      {to ? (
        <StopLine
          name={leg.to.name}
          time={leg.arrival}
          scheduled={leg.scheduledArrival}
          track={leg.to.track}
          scheduledTrack={leg.to.scheduledTrack}
          cancelled={leg.to.cancelled}
          label={copy.journeys.arrival}
        />
      ) : null}
    </li>
  );
}

function walkMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** One row per change: the station once, the arrival over the next departure, the time to change. */
function ChangeDetail({ item }: { item: Extract<DetailItem, { kind: "change" }> }) {
  const copy = useJourneysCopy();
  const { clock } = useFormatters();
  const { arrive, depart, walk } = item;
  const minutes = Math.round((Date.parse(depart.departure) - Date.parse(arrive.arrival)) / 60_000);
  const arrivalTrack = trackText(copy, arrive.to.track, arrive.to.scheduledTrack);
  const departureTrack = trackText(copy, depart.from.track, depart.from.scheduledTrack);
  const elsewhere = depart.from.name !== arrive.to.name;
  return (
    <li
      data-slot="journey-change"
      className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-l-2 py-1 pl-3"
      style={{ borderColor: "var(--gl-hairline)" }}
    >
      <Time
        time={arrive.arrival}
        scheduled={arrive.scheduledArrival}
        clock={clock}
        label={copy.journeys.arrival}
      />
      <div className="flex flex-col">
        <span className="type-body-strong wrap-break-word">{arrive.to.name}</span>
        {arrivalTrack ? <span className="type-caption text-ink-muted">{arrivalTrack}</span> : null}
      </div>
      <Time
        time={depart.departure}
        scheduled={depart.scheduledDeparture}
        clock={clock}
        label={copy.journeys.departure}
      />
      <div className="flex flex-col">
        {elsewhere ? (
          <span className="type-body-strong wrap-break-word">{depart.from.name}</span>
        ) : null}
        {departureTrack ? (
          <span className="type-caption text-ink-muted">{departureTrack}</span>
        ) : null}
        <span className="type-caption inline-flex flex-wrap items-center gap-x-2 text-ink-muted">
          <MixedText text={copy.journeys.changeTime(Math.max(0, minutes))} />
          {walk ? (
            <span className="inline-flex items-center gap-1">
              <Footprints aria-hidden="true" className="size-3.5" />
              <MixedText text={copy.journeys.walk(walkMinutes(walk.durationS))} />
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function detailKey(item: DetailItem): string {
  return item.kind === "change" ? `change|${legKey(item.depart)}` : legKey(item.leg);
}

function JourneyDetail({ journey }: { journey: Journey }) {
  const copy = useJourneysCopy();
  return (
    <ol data-slot="journey-detail" className="flex flex-col gap-2 px-4 pt-1 pb-3">
      {detailItems(journey.legs).map((item) => {
        if (item.kind === "transit") {
          return (
            <TransitDetail key={detailKey(item)} leg={item.leg} from={item.from} to={item.to} />
          );
        }
        if (item.kind === "change") return <ChangeDetail key={detailKey(item)} item={item} />;
        return (
          <li
            key={detailKey(item)}
            className="type-caption flex items-center gap-2 py-1 pl-[4.75rem] text-ink-muted"
          >
            <Footprints aria-hidden="true" className="size-4" />
            <MixedText text={copy.journeys.walk(walkMinutes(item.leg.durationS))} />
          </li>
        );
      })}
    </ol>
  );
}

function errorText(copy: JourneysCopy, error: JourneyError): string {
  switch (error) {
    case "busy":
      return copy.errors.busy;
    case "stop":
      return copy.errors.stop;
    case "rejected":
      return copy.errors.rejected;
    case "limited":
      return copy.errors.limited;
    default:
      return copy.errors.unavailable;
  }
}

function PageButton({
  direction,
  results,
}: {
  direction: "earlier" | "later";
  results: Extract<ResultsState, { status: "ready" }>;
}) {
  const copy = useJourneysCopy();
  const page = usePlannerStore((state) => state.page);
  const cursor = direction === "earlier" ? results.earlierCursor : results.laterCursor;
  if (!cursor) return null;
  const Icon = direction === "earlier" ? ChevronUp : ChevronDown;
  return (
    <Button
      variant="quiet"
      className="mx-4 justify-start self-start"
      loading={results.paging === direction}
      disabled={results.paging !== null && results.paging !== direction}
      onClick={() => void page(direction)}
    >
      <Icon aria-hidden="true" />
      {direction === "earlier" ? copy.journeys.earlier : copy.journeys.later}
    </Button>
  );
}

function LoadingRows() {
  const copy = useJourneysCopy();
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true">
      <span className="sr-only">{copy.journeys.searching}</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      ))}
    </div>
  );
}

/**
 * The journeys found, earliest first, with Earlier and Later around them. The selected journey
 * opens its legs under its row and is the one drawn on the map.
 */
export function JourneyResults({ showSelectedDetail = true }: { showSelectedDetail?: boolean }) {
  const results = usePlannerStore((state) => state.results);
  if (results.status === "idle") return null;
  if (results.status === "loading") return <LoadingRows />;
  return <ResultsBody results={results} showSelectedDetail={showSelectedDetail} />;
}

/** Nothing found: the message, what the filters left out and the way to search without them. */
function EmptyResults({ removed }: { removed: number }) {
  const copy = useJourneysCopy();
  const filtered = usePlannerStore(
    (state) => state.categories.length < PLANNER_CATEGORIES.length || state.operator.trim() !== "",
  );
  const widen = usePlannerStore((state) => state.widen);
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-2">
      <p className="type-body text-ink">{copy.journeys.empty}</p>
      {removed > 0 ? (
        <p className="type-caption text-ink-muted">{copy.journeys.removed(removed)}</p>
      ) : null}
      {filtered ? (
        <Button variant="secondary" onClick={() => void widen()}>
          {copy.journeys.widen}
        </Button>
      ) : null}
    </div>
  );
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Brings the results to the top of the card or sheet body that scrolls them, unless the shown
 * journey is already in view (a link on a tall screen keeps its form). Only that body moves:
 * `scrollIntoView` would also scroll the clipped card or sheet and hide its head.
 */
function useScrollIntoViewOnce(ref: React.RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    const element = ref.current;
    if (key === null || !element) return;
    const container = scrollParent(element);
    if (!container) return;
    const frame = container.getBoundingClientRect();
    const shown = element.querySelector("[data-slot=journey-row][aria-pressed=true]");
    const top = resultsScrollTop(
      { top: frame.top, bottom: frame.bottom, scrollTop: container.scrollTop },
      element.getBoundingClientRect(),
      shown?.getBoundingClientRect() ?? null,
      RESULTS_TOP_GAP,
    );
    if (top === null) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo?.({ top, behavior: reduced ? "auto" : "smooth" });
  }, [ref, key]);
}

const RESULTS_TOP_GAP = 8;

function ResultsBody({
  results,
  showSelectedDetail,
}: {
  results: Exclude<ResultsState, { status: "idle" } | { status: "loading" }>;
  showSelectedDetail: boolean;
}) {
  const copy = useJourneysCopy();
  const selectedId = usePlannerStore((state) => state.selectedId);
  const select = usePlannerStore((state) => state.select);
  const search = usePlannerStore((state) => state.search);
  const searched = usePlannerStore((state) => state.searched);
  const top = useRef<HTMLElement>(null);
  useScrollIntoViewOnce(top, searched);
  if (results.status === "error") {
    return (
      <div ref={top as React.RefObject<HTMLDivElement>} className="flex flex-col gap-2 px-4 py-3">
        <Notice tone="error" icon={<CircleAlert />}>
          {errorText(copy.journeys, results.error)}
        </Notice>
        {results.error === "busy" || results.error === "unavailable" ? (
          <Button variant="secondary" className="self-start" onClick={() => void search()}>
            {copy.journeys.retry}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <section
      ref={top}
      aria-label={copy.journeys.results}
      className="flex scroll-mt-2 flex-col gap-1 pb-2"
    >
      <PageButton direction="earlier" results={results} />
      {results.journeys.length === 0 ? (
        <EmptyResults removed={results.removed} />
      ) : (
        <ul className="flex flex-col border-y border-hairline">
          {results.journeys.map((journey) => (
            <li key={journey.id} className="border-b border-hairline last:border-b-0">
              <JourneyRow
                journey={journey}
                selected={journey.id === selectedId}
                onSelect={() => select(journey.id)}
              />
              {showSelectedDetail && journey.id === selectedId ? (
                <JourneyDetail journey={journey} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <PageButton direction="later" results={results} />
      <div role="status" className="flex flex-col gap-1 px-4">
        {results.pageError ? (
          <p className="type-caption text-ink">{errorText(copy.journeys, results.pageError)}</p>
        ) : null}
        {results.removed > 0 && results.journeys.length > 0 ? (
          <p className="type-caption text-ink-muted">{copy.journeys.removed(results.removed)}</p>
        ) : null}
        {results.partial ? (
          <p className="type-caption text-ink-muted">{copy.journeys.partial}</p>
        ) : null}
      </div>
      <p className="type-caption px-4 pt-1 text-ink-muted">{copy.journeys.reliability.rule}</p>
      <p className="type-caption px-4 text-ink-muted">{copy.journeys.source}</p>
    </section>
  );
}

export { JourneyDetail, JourneyRow };
