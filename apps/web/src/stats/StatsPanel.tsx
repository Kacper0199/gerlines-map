import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import { BottomSheet, Button, IconButton, Notice, SheetMore, Skeleton, Toggle } from "@gerlines/ui";
import { CircleAlert, RotateCw, Table2, X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { restoreFocus, slotButton } from "../a11y/focus.ts";
import { useFocusOnOpen } from "../a11y/use-focus-on-open.ts";
import { AreaPicker } from "./AreaPicker.tsx";
import type { StatsArea } from "./area.ts";
import { formatDay } from "./format.ts";
import { useLandSync } from "./land-sync.ts";
import { productOfLines } from "./model.ts";
import { PeriodPicker } from "./PeriodPicker.tsx";
import { Provenance } from "./Provenance.tsx";
import { berlinDay, periodRange, validateRange } from "./periods.ts";
import { StatsBody } from "./StatsBody.tsx";
import { useSheetHeight } from "./sheet-height.ts";
import type { StatsData } from "./stats-client.ts";
import { useStatsStore } from "./store.ts";
import { useCooldown } from "./use-cooldown.ts";
import { useLaender } from "./use-laender.ts";
import { type StatsView, useStats } from "./use-stats.ts";

const NEW_DAY_UNTIL_HOUR = 4;

function berlinHour(iso: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(Date.parse(iso));
  return Number(hour);
}

function useCloseOnEscape(close: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

function useScopeTitle(area: StatsArea | null, data: StatsData | null): string | null {
  const copy = useStatsCopy();
  const locale = useLocale();
  const laender = useLaender();
  if (area === null) return null;
  switch (area.kind) {
    case "network":
      return copy.stats.area.network;
    case "land":
      return laender.find((land) => land.code === area.code)?.names[locale] ?? area.code;
    case "station":
      return area.name;
    case "train": {
      const product =
        data?.kind === "train" ? productOfLines(data.groups.map((g) => g.line)) : null;
      return product === null ? copy.stats.scope.train(area.number) : `${product} ${area.number}`;
    }
    case "line":
      return copy.stats.scope.line(area.name);
  }
}

function Failure({
  view,
  retry,
}: {
  view: Extract<StatsView, { state: "failed" }>;
  retry: () => void;
}) {
  const copy = useStatsCopy();
  const waiting = useCooldown(view.retryAfterS, view);
  return (
    <div className="flex flex-col items-start gap-3">
      <Notice tone="error" role="alert" icon={<CircleAlert />} className="self-stretch">
        {copy.stats.errors[view.failure]}
      </Notice>
      <Button variant="secondary" disabled={waiting > 0} onClick={retry}>
        <RotateCw aria-hidden="true" />
        {waiting > 0 ? copy.stats.retryIn(waiting) : copy.train.retry}
      </Button>
    </div>
  );
}

function Results({ phone }: { phone: boolean }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const area = useStatsStore((state) => state.area);
  const period = useStatsStore((state) => state.period);
  const tables = useStatsStore((state) => state.tables);
  const today = berlinDay(Date.now());
  const range = periodRange(period, today);
  const { view, retry } = useStats(area, range, period.kind === "today");
  const title = useScopeTitle(area, view.data);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnOpen(heading, !phone);
  const check = validateRange(range.from, range.to);
  if (area === null || title === null || !check.ok) return null;
  const shown = view.data?.period ?? { ...range, days: check.days };
  const periodText =
    shown.from === shown.to
      ? formatDay(shown.from, locale)
      : `${copy.stats.period.range(formatDay(shown.from, locale), formatDay(shown.to, locale))}, ${copy.stats.period.days(shown.days)}`;
  const earlyHint =
    period.kind === "today" &&
    view.data !== null &&
    berlinHour(view.data.generatedAt) < NEW_DAY_UNTIL_HOUR;
  return (
    <div
      className="flex flex-col gap-3"
      aria-busy={view.state === "loading" || view.state === "refreshing"}
    >
      <header className="flex flex-col gap-1 border-t pt-3">
        <h2
          ref={heading}
          tabIndex={-1}
          className="type-headline wrap-break-word text-[24px] outline-none sm:text-[28px]"
        >
          {title}
        </h2>
        <p className="type-body text-ink-muted">
          {periodText}
          {view.state === "refreshing" ? <span className="ml-2">{copy.stats.updating}</span> : null}
        </p>
      </header>
      {view.state === "loading" || view.state === "idle" ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="type-body text-ink-muted">{copy.stats.loading}</p>
          <Skeleton className="h-16 w-40 bg-hairline" />
          <Skeleton className="h-40 w-full bg-hairline" />
        </div>
      ) : null}
      {view.state === "failed" ? <Failure view={view} retry={retry} /> : null}
      {view.data !== null ? (
        <div
          className={
            view.state === "refreshing"
              ? "flex flex-col gap-3 opacity-60 transition-opacity"
              : "flex flex-col gap-3"
          }
        >
          <StatsBody
            key={JSON.stringify(area)}
            data={view.data}
            tables={tables}
            earlyHint={earlyHint}
          />
          <Provenance data={view.data} />
        </div>
      ) : null}
    </div>
  );
}

function Controls({ tabsHost }: { tabsHost?: HTMLElement | null | undefined }): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <AreaPicker tabsHost={tabsHost} />
      <PeriodPicker />
    </div>
  );
}

const PEEK_MAX = 440;
const PEEK_SHARE = 0.5;

function subscribeResize(notify: () => void): () => void {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
}

/** The phone sheet peeks high enough to show the controls and the headline figure, at most half the screen. */
function usePeekHeight(): number {
  const height = useSyncExternalStore(
    subscribeResize,
    () => window.innerHeight,
    () => 0,
  );
  return Math.min(PEEK_MAX, Math.round(height * PEEK_SHARE));
}

function useScrollTopOnAreaChange(panel: RefObject<HTMLElement | null>, active: boolean): void {
  const kind = useStatsStore((state) => state.kind);
  const shown = useRef(kind);
  useEffect(() => {
    if (shown.current === kind) return;
    shown.current = kind;
    if (!active) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.current?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [kind, active, panel]);
}

export default function StatsPanel({ phone }: { phone: boolean }) {
  const peekHeight = usePeekHeight();
  const copy = useStatsCopy();
  const tables = useStatsStore((state) => state.tables);
  const setTables = useStatsStore((state) => state.setTables);
  const setOpen = useStatsStore((state) => state.setOpen);
  const close = useCallback(() => {
    setOpen(false);
    restoreFocus(slotButton("stats-button"));
  }, [setOpen]);
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const [tabsHost, setTabsHost] = useState<HTMLElement | null>(null);
  useScrollTopOnAreaChange(article, !phone);
  useLandSync();
  useCloseOnEscape(close);
  useSheetHeight(body, phone);
  const actions = (
    <>
      <Toggle
        aria-label={copy.stats.table.toggle}
        title={copy.stats.table.toggle}
        pressed={tables}
        onPressedChange={setTables}
        className="size-target"
      >
        <Table2 aria-hidden="true" />
      </Toggle>
      <IconButton label={copy.stats.close} onClick={close}>
        <X aria-hidden="true" />
      </IconButton>
    </>
  );
  const content = (
    <div ref={body} className="flex flex-col gap-3 px-4 pb-4">
      <Controls tabsHost={phone ? undefined : tabsHost} />
      {phone ? (
        <SheetMore>
          <Results phone />
        </SheetMore>
      ) : (
        <Results phone={false} />
      )}
    </div>
  );
  if (phone) {
    return (
      <BottomSheet
        label={copy.stats.title}
        peekHeight={peekHeight}
        expandLabel={copy.stats.sheetExpand}
        collapseLabel={copy.stats.sheetCollapse}
        leading={<span className="type-label text-ink-muted">{copy.stats.title}</span>}
        trailing={<div className="flex items-center">{actions}</div>}
        className="pointer-events-auto z-20"
      >
        {content}
      </BottomSheet>
    );
  }
  return (
    <article
      ref={article}
      aria-label={copy.stats.title}
      className="card-surface card-enter pointer-events-auto flex min-h-0 flex-col overflow-y-auto"
    >
      <div data-slot="stats-head" className="sticky top-0 z-10 shrink-0 border-b bg-surface">
        <div className="flex min-h-target items-center justify-between gap-2 pl-4 pr-1 pt-2">
          <span className="type-label text-ink-muted">{copy.stats.title}</span>
          <div className="flex items-center">{actions}</div>
        </div>
        <div ref={setTabsHost} data-slot="stats-head-tabs" className="px-4 pb-1.5 pt-0.5" />
      </div>
      {content}
    </article>
  );
}
