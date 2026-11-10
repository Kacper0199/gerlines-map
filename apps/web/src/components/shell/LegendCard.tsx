import { useCopy, useLocale } from "@gerlines/i18n/react";
import { Card, LegendRow, Num, Separator } from "@gerlines/ui";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { InViewButton } from "../../inview/InViewEntry.tsx";
import type { DelayClass } from "../../modes/delay.ts";
import type { OperatorGroup } from "../../modes/operator-groups.ts";
import type { CategoryKey } from "../../motion/categories.ts";
import type { DataStatus } from "../../motion/protocol.ts";
import { useAppStore } from "../../state/store.ts";
import { LabelModeControl } from "./LabelModeControl.tsx";
import { DelayRows, ToggleRow } from "./LegendDelayRows.tsx";
import { OperatorRows } from "./LegendOperatorRows.tsx";
import { foldsLabelControl, type LegendFit } from "./legend-fit.ts";

const DOMESTIC: readonly CategoryKey[] = ["hsr", "ld", "night", "rfast", "reg", "sbahn"];

function hasCounts(status: DataStatus): boolean {
  return status.state !== "loading" && status.dataTimeMs !== undefined && status.framed !== false;
}

function Totals() {
  const copy = useCopy();
  const locale = useLocale();
  const status = useAppStore((state) => state.status);
  if (!hasCounts(status)) {
    return (
      <span className="type-caption text-ink-muted">
        {status.state === "error" ? copy.live.error : copy.live.loading}
      </span>
    );
  }
  return (
    <span className="type-caption text-ink-muted">
      <span className="whitespace-nowrap">
        <Num value={status.trips} locale={locale} /> {copy.legend.total}
      </span>
      ,{" "}
      <span className="whitespace-nowrap">
        <Num value={status.realtime} locale={locale} /> {copy.legend.realtime}
      </span>
    </span>
  );
}

function useCategoryRows() {
  const copy = useCopy();
  const locale = useLocale();
  const counts = useAppStore((state) => state.status.counts);
  const countsKnown = useAppStore((state) => hasCounts(state.status));
  const hidden = useAppStore((state) => state.hiddenCategories);
  const setVisible = useAppStore((state) => state.setCategoryVisible);
  const colourMode = useAppStore((state) => state.colourMode);
  return (category: CategoryKey) =>
    colourMode !== "category" ? (
      <ToggleRow
        key={category}
        category={category}
        name={copy.categories[category].legend}
        count={countsKnown ? counts[category] : null}
        checked={!hidden.includes(category)}
        onCheckedChange={(checked) => setVisible(category, checked)}
      />
    ) : (
      <LegendRow
        key={category}
        category={category}
        name={copy.categories[category].legend}
        count={countsKnown ? counts[category] : null}
        locale={locale}
        checked={!hidden.includes(category)}
        onCheckedChange={(checked) => setVisible(category, checked)}
      />
    );
}

function Untracked() {
  const copy = useCopy();
  const untracked = useAppStore((state) => state.status.untracked);
  return untracked > 0 ? (
    <p role="note" className="type-caption mt-2 px-1 text-ink-muted">
      {copy.legend.untracked(untracked)}
    </p>
  ) : null;
}

function CategoryRows() {
  const row = useCategoryRows();
  return (
    <div className="flex flex-col px-3">
      {DOMESTIC.map(row)}
      <Separator className="my-1" />
      {row("foreign")}
      <Untracked />
    </div>
  );
}

function ShowOnTheMap() {
  const copy = useCopy();
  const row = useCategoryRows();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        data-fit-pin=""
        onClick={() => setOpen(!open)}
        className="focus-ring type-label flex min-h-target w-full items-center justify-between gap-2 px-4 focus-visible:outline-offset-[-2px]!"
      >
        {copy.legend.show}
        <ChevronDown
          aria-hidden="true"
          className="size-[18px] shrink-0 text-ink-muted transition-transform data-[open=true]:rotate-180"
          data-open={open}
        />
      </button>
      <div id={bodyId} hidden={!open} className="flex flex-col px-3 pb-2">
        {DOMESTIC.map(row)}
        <Separator className="my-1" />
        {row("foreign")}
        <Untracked />
      </div>
    </>
  );
}

function DelayBody({ foldLabels }: { foldLabels: boolean }) {
  const countsKnown = useAppStore((state) => hasCounts(state.status));
  const delayCounts = useAppStore((state) => state.status.delayCounts);
  const known: Readonly<Record<DelayClass, number>> | null =
    countsKnown && delayCounts ? delayCounts : null;
  return (
    <>
      <div className="flex flex-col px-3">
        <DelayRows counts={known} />
      </div>
      <Separator className="mt-1" />
      <LabelModeControl folded={foldLabels} />
      <Separator />
      <ShowOnTheMap />
    </>
  );
}

function OperatorBody({ foldLabels }: { foldLabels: boolean }) {
  const countsKnown = useAppStore((state) => hasCounts(state.status));
  const operatorCounts = useAppStore((state) => state.status.operatorCounts);
  const hidden = useAppStore((state) => state.hiddenOperatorGroups);
  const setVisible = useAppStore((state) => state.setOperatorGroupVisible);
  const known: Readonly<Record<OperatorGroup, number>> | null =
    countsKnown && operatorCounts ? operatorCounts : null;
  return (
    <>
      <div className="flex flex-col px-3">
        <OperatorRows counts={known} hidden={hidden} onVisibleChange={setVisible} />
      </div>
      <Separator className="mt-1" />
      <LabelModeControl folded={foldLabels} />
      <Separator />
      <ShowOnTheMap />
    </>
  );
}

export function LegendCard({
  collapsible = false,
  defaultOpen = true,
  fit = "full",
  className,
}: {
  collapsible?: boolean;
  defaultOpen?: boolean;
  fit?: LegendFit;
  className?: string;
}) {
  const copy = useCopy();
  const [userOpen, setUserOpen] = useState(defaultOpen);
  const bodyId = useId();
  const colourMode = useAppStore((state) => state.colourMode);
  const expanded = !collapsible || userOpen;
  const foldLabels = foldsLabelControl(fit);
  return (
    <Card
      aria-label={copy.legend.label}
      className={className}
      data-slot="legend-card"
      role="region"
    >
      <div className="flex items-start">
        {collapsible ? (
          <h2 className="min-w-0 flex-1">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              data-fit-pin=""
              onClick={() => setUserOpen(!userOpen)}
              className="focus-ring flex min-h-target w-full items-center justify-between gap-2 px-4 focus-visible:outline-offset-[-2px]!"
            >
              <span className="flex min-w-0 flex-col items-start text-left">
                <span className="type-title">{copy.legend.title}</span>
                <Totals />
              </span>
              <ChevronDown
                aria-hidden="true"
                className="size-[18px] shrink-0 text-ink-muted transition-transform data-[open=true]:rotate-180"
                data-open={expanded}
              />
            </button>
          </h2>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col items-start px-4">
            <h2 className="type-title">{copy.legend.title}</h2>
            <Totals />
          </div>
        )}
        <InViewButton className="mr-1 mt-0.5" />
      </div>
      <div id={bodyId} hidden={!expanded}>
        {colourMode === "delay" ? (
          <DelayBody foldLabels={foldLabels} />
        ) : colourMode === "operator" ? (
          <OperatorBody foldLabels={foldLabels} />
        ) : (
          <>
            <CategoryRows />
            <LabelModeControl folded={foldLabels} />
          </>
        )}
      </div>
    </Card>
  );
}
