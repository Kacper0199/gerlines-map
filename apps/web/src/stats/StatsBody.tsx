import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsDay, StatsDelayBin, StatsNetwork, StatsRunGroup } from "@gerlines/schema/stats";
import { Notice, Tabs, TabsContent, TabsList, TabsTrigger } from "@gerlines/ui";
import { type ReactNode, useState } from "react";
import { CategoryBars, categoryLabel } from "./charts/CategoryBars.tsx";
import { DayChart } from "./charts/DayChart.tsx";
import { binTitle, DelayChart } from "./charts/DelayChart.tsx";
import { HourChart, hourName } from "./charts/HourChart.tsx";
import { DataTable } from "./DataTable.tsx";
import { Facts, Headline } from "./Facts.tsx";
import { formatDay, numberFormat } from "./format.ts";
import { delayClasses, durationText, emptyReason, hourSeries, percentOf } from "./model.ts";
import { NumberText, Percent } from "./NumberText.tsx";
import type { StatsData } from "./stats-client.ts";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t pt-3" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h3 className="type-label">{title}</h3>
        {note === undefined ? null : <p className="type-caption text-ink-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({
  reason,
  earlyHint,
}: {
  reason: "no-stops" | "no-realtime" | "no-arrivals";
  earlyHint: boolean;
}) {
  const copy = useStatsCopy();
  return (
    <Notice role="status" className="flex-col">
      <p className="type-body-strong">{copy.stats.empty.title}</p>
      <p className="type-body text-ink-muted">{copy.stats.empty[reason]}</p>
      {earlyHint ? <p className="type-body text-ink-muted">{copy.stats.empty.newDay}</p> : null}
    </Notice>
  );
}

function DelaySection({
  histogram,
  tables,
}: {
  histogram: readonly StatsDelayBin[];
  tables: boolean;
}) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const totals = delayClasses(histogram);
  if (totals.total === 0) return null;
  const count = numberFormat(locale, 0);
  return (
    <Section title={copy.stats.delay.title} note={copy.stats.delay.note}>
      {tables ? (
        <DataTable
          caption={copy.stats.delay.title}
          head={[copy.stats.delay.axis, copy.stats.fact.observed, copy.stats.table.share]}
          rows={histogram.map((bin) => [
            binTitle(bin, copy),
            count.format(bin.count),
            percentOf(bin.count / totals.total, locale, copy.stats.under) ?? "",
          ])}
        />
      ) : (
        <DelayChart histogram={histogram} />
      )}
    </Section>
  );
}

function DaySection({ days, tables }: { days: readonly StatsDay[]; tables: boolean }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  if (days.length < 2) return null;
  return (
    <Section title={copy.stats.day.title} note={copy.stats.day.note}>
      {tables ? (
        <DataTable
          caption={copy.stats.day.title}
          head={[
            copy.stats.table.day,
            copy.stats.punctual.title,
            copy.stats.fact.observedArrivals,
            copy.stats.fact.mean,
          ]}
          rows={days.map((entry) => [
            formatDay(entry.day, locale),
            percentOf(entry.punctual6, locale) ?? copy.delay.noData,
            numberFormat(locale, 0).format(entry.observedArrivals),
            durationText(entry.meanDelayS, locale, copy.delay.minutes) ?? copy.delay.noData,
          ])}
        />
      ) : (
        <DayChart days={days} />
      )}
    </Section>
  );
}

function HourSection({
  hours,
  average,
  tables,
}: {
  hours: StatsNetwork["byHour"];
  average: number | null;
  tables: boolean;
}) {
  const copy = useStatsCopy();
  const locale = useLocale();
  if (hours.every((entry) => entry.observedArrivals === 0)) return null;
  return (
    <Section title={copy.stats.hour.title} note={copy.stats.hour.note}>
      {tables ? (
        <DataTable
          caption={copy.stats.hour.title}
          head={[
            copy.stats.table.hour,
            copy.stats.punctual.title,
            copy.stats.fact.observedArrivals,
            copy.stats.fact.mean,
          ]}
          rows={hourSeries(hours).map((entry) => [
            hourName(entry.hour),
            percentOf(entry.punctual6, locale) ?? copy.delay.noData,
            numberFormat(locale, 0).format(entry.observedArrivals),
            durationText(entry.meanDelayS, locale, copy.delay.minutes) ?? copy.delay.noData,
          ])}
        />
      ) : (
        <HourChart hours={hours} average={average} />
      )}
    </Section>
  );
}

function CategorySection({ rows }: { rows: StatsNetwork["byCategory"] }) {
  const copy = useStatsCopy();
  if (rows.length === 0) return null;
  return (
    <Section title={copy.stats.category.title} note={copy.stats.category.note}>
      <CategoryBars rows={rows} />
    </Section>
  );
}

function OperatorSection({ rows }: { rows: readonly OperatorRow[] }) {
  const copy = useStatsCopy();
  if (rows.length === 0) return null;
  return (
    <Section title={copy.stats.operators.title}>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.operator?.id ?? "unknown"}
            className="type-body flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0"
          >
            <span className="min-w-0 wrap-break-word">
              {row.operator?.name ?? row.operator?.id ?? copy.stats.operators.unknown}
            </span>
            <span className="type-data shrink-0">
              {row.summary.punctual6 === null ? (
                copy.delay.noData
              ) : (
                <Percent share={row.summary.punctual6} />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

interface OperatorRow {
  readonly operator: { readonly id: string; readonly name: string | null } | null;
  readonly summary: StatsNetwork["summary"];
}

function Departures({ observed, punctual6 }: { observed: number; punctual6: number | null }) {
  const copy = useStatsCopy();
  return (
    <dl className="m-0 flex flex-col border-t pt-3" data-slot="departures">
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="type-body text-ink-muted">{copy.stats.fact.departures}</dt>
        <dd className="type-data m-0">
          <NumberText value={observed} />
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="type-body text-ink-muted">{copy.stats.fact.departuresPunctual}</dt>
        <dd className="type-data m-0">
          {punctual6 === null ? (
            <span className="type-body font-normal text-ink-muted">{copy.delay.noData}</span>
          ) : (
            <Percent share={punctual6} />
          )}
        </dd>
      </div>
    </dl>
  );
}

function Overview({
  data,
  tables,
  earlyHint,
}: {
  data: Extract<StatsData, { kind: "network" | "land" | "station" }>;
  tables: boolean;
  earlyHint: boolean;
}) {
  const reason = emptyReason(data.summary);
  if (reason === "no-stops") return <Empty reason={reason} earlyHint={earlyHint} />;
  return (
    <>
      <Headline summary={data.summary} />
      <Facts summary={data.summary} />
      {data.kind === "station" ? <Departures {...data.departures} /> : null}
      <DelaySection histogram={data.delayHistogram} tables={tables} />
      <CategorySection rows={data.byCategory} />
      <HourSection hours={data.byHour} average={data.summary.punctual6} tables={tables} />
      <DaySection days={data.byDay} tables={tables} />
      {data.kind === "station" ? <OperatorSection rows={data.byOperator} /> : null}
    </>
  );
}

function groupName(copy: ReturnType<typeof useStatsCopy>, group: StatsRunGroup): string {
  const operator = group.operator?.name ?? group.operator?.id ?? copy.stats.operators.unknown;
  const parts = [operator, categoryLabel(copy, group.category)];
  if (group.line !== null) parts.push(copy.stats.scope.line(group.line));
  return parts.join(", ");
}

function Runs({
  data,
  tables,
  earlyHint,
}: {
  data: Extract<StatsData, { kind: "train" | "line" }>;
  tables: boolean;
  earlyHint: boolean;
}) {
  const copy = useStatsCopy();
  const [picked, setPicked] = useState<string | null>(null);
  const names = data.groups.map((entry) => groupName(copy, entry));
  const index = Math.max(0, names.indexOf(picked ?? ""));
  const group = data.groups[index];
  if (group === undefined) return <Empty reason="no-stops" earlyHint={earlyHint} />;
  const reason = emptyReason(group.summary);
  const results =
    reason === "no-stops" ? (
      <Empty reason={reason} earlyHint={earlyHint} />
    ) : (
      <>
        <Headline summary={group.summary} />
        <Facts summary={group.summary} runs={group.runs} />
        <DelaySection histogram={group.delayHistogram} tables={tables} />
        <DaySection days={group.byDay} tables={tables} />
      </>
    );
  if (data.groups.length < 2) {
    return (
      <>
        <p className="type-body-strong">{names[index]}</p>
        {results}
      </>
    );
  }
  return (
    <Tabs value={names[index]} onValueChange={setPicked} className="gap-3">
      <TabsList
        aria-label={copy.stats.groupsTitle}
        className="flex-wrap gap-x-3 gap-y-0 overflow-visible"
      >
        {names.map((name) => (
          <TabsTrigger
            key={name}
            value={name}
            className="h-auto min-h-target py-1 text-left whitespace-normal"
          >
            {name}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent
        value={names[index] ?? ""}
        tabIndex={-1}
        className="flex flex-none flex-col gap-3 text-base outline-none"
      >
        {results}
      </TabsContent>
    </Tabs>
  );
}

export function StatsBody({
  data,
  tables,
  earlyHint,
}: {
  data: StatsData;
  tables: boolean;
  earlyHint: boolean;
}) {
  return data.kind === "train" || data.kind === "line" ? (
    <Runs data={data} tables={tables} earlyHint={earlyHint} />
  ) : (
    <Overview data={data} tables={tables} earlyHint={earlyHint} />
  );
}
