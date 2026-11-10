import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import { IconButton, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@gerlines/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Field } from "./Field.tsx";
import { formatMonth } from "./format.ts";
import {
  addDays,
  berlinDay,
  clampRange,
  FIRST_DAY,
  FIRST_MONTH,
  type MonthRef,
  monthOf,
  type PeriodChoice,
  shiftMonth,
  validateRange,
} from "./periods.ts";
import { useStatsStore } from "./store.ts";

const COMMIT_DELAY_MS = 400;

type Tab = "today" | "days7" | "days30" | "month" | "custom";

function tabOf(period: PeriodChoice): Tab {
  if (period.kind === "days") return period.count === 7 ? "days7" : "days30";
  return period.kind;
}

function isTab(value: unknown): value is Tab {
  return ["today", "days7", "days30", "month", "custom"].includes(String(value));
}

function periodForTab(tab: Tab, today: string): PeriodChoice {
  switch (tab) {
    case "today":
      return { kind: "today" };
    case "days7":
      return { kind: "days", count: 7 };
    case "days30":
      return { kind: "days", count: 30 };
    case "month":
      return { kind: "month", ...monthOf(today) };
    case "custom":
      return { kind: "custom", from: addDays(today, -6), to: today };
  }
}

function MonthStepper({ month }: { month: MonthRef }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const setPeriod = useStatsStore((state) => state.setPeriod);
  const current = monthOf(berlinDay(Date.now()));
  const index = (ref: MonthRef) => ref.year * 12 + ref.month;
  const go = (delta: number) => setPeriod({ kind: "month", ...shiftMonth(month, delta) });
  return (
    <div className="flex items-center justify-between gap-2">
      <IconButton
        label={copy.stats.period.monthPrevious}
        disabled={index(month) <= index(FIRST_MONTH)}
        onClick={() => go(-1)}
      >
        <ChevronLeft aria-hidden="true" />
      </IconButton>
      <span className="type-body-strong" aria-live="polite">
        {formatMonth(month.year, month.month, locale)}
      </span>
      <IconButton
        label={copy.stats.period.monthNext}
        disabled={index(month) >= index(current)}
        onClick={() => go(1)}
      >
        <ChevronRight aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * The two day fields. A date field fires on every digit of the year, and the API allows ten
 * long periods a minute, so the range is applied after typing pauses or when a field loses focus,
 * held inside the days that can have statistics.
 */
function CustomRange({ from, to }: { from: string; to: string }) {
  const copy = useStatsCopy();
  const setPeriod = useStatsStore((state) => state.setPeriod);
  const today = berlinDay(Date.now());
  const [draft, setDraft] = useState({ from, to });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = validateRange(draft.from, draft.to);

  useEffect(() => {
    setDraft({ from, to });
  }, [from, to]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (range: { from: string; to: string }) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const clamped = clampRange(range, berlinDay(Date.now()));
    setDraft(clamped);
    setPeriod({ kind: "custom", ...clamped });
  };
  const edit = (next: { from: string; to: string }) => {
    setDraft(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), COMMIT_DELAY_MS);
  };
  const bounds = { min: FIRST_DAY, max: today };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label={copy.stats.period.from}>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={draft.from}
              aria-invalid={!check.ok}
              {...bounds}
              onChange={(event) => edit({ ...draft, from: event.target.value })}
              onBlur={() => commit(draft)}
            />
          )}
        </Field>
        <Field label={copy.stats.period.to}>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={draft.to}
              aria-invalid={!check.ok}
              {...bounds}
              onChange={(event) => edit({ ...draft, to: event.target.value })}
              onBlur={() => commit(draft)}
            />
          )}
        </Field>
      </div>
      {check.ok ? null : (
        <p aria-live="polite" className="type-caption text-ink">
          {copy.stats.period.problem[check.problem]}
        </p>
      )}
    </div>
  );
}

export function PeriodPicker() {
  const copy = useStatsCopy();
  const period = useStatsStore((state) => state.period);
  const setPeriod = useStatsStore((state) => state.setPeriod);
  const today = berlinDay(Date.now());
  const labels: Record<Tab, string> = {
    today: copy.stats.period.today,
    days7: copy.stats.period.days7,
    days30: copy.stats.period.days30,
    month: copy.stats.period.month,
    custom: copy.stats.period.custom,
  };
  return (
    <div className="flex flex-col gap-2" data-slot="period-picker">
      <Tabs
        value={tabOf(period)}
        onValueChange={(value) => {
          if (isTab(value)) setPeriod(periodForTab(value, today));
        }}
      >
        <TabsList
          aria-label={copy.stats.period.label}
          className="flex-wrap gap-x-1 gap-y-0 overflow-visible"
        >
          {(Object.keys(labels) as Tab[]).map((tab) => (
            <TabsTrigger key={tab} value={tab} className="px-1.5">
              {labels[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
        {(Object.keys(labels) as Tab[]).map((tab) => (
          <TabsContent
            key={tab}
            value={tab}
            tabIndex={-1}
            className="flex-none text-base outline-none"
          >
            {period.kind === "month" && tab === "month" ? <MonthStepper month={period} /> : null}
            {period.kind === "custom" && tab === "custom" ? (
              <CustomRange from={period.from} to={period.to} />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
