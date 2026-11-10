import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsSummary } from "@gerlines/schema/stats";
import type { ReactNode } from "react";
import { emptyReason, percentNumber, percentSign } from "./model.ts";
import { Duration, NumberText, Percent } from "./NumberText.tsx";

export function Headline({ summary }: { summary: StatsSummary }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const reason = emptyReason(summary);
  return (
    <section
      className="flex flex-col gap-1"
      aria-label={copy.stats.punctual.title}
      data-slot="headline"
    >
      <h3 className="type-label text-ink-muted">{copy.stats.punctual.title}</h3>
      {summary.punctual6 === null ? (
        <>
          <p className="type-body-strong text-ink-muted">{copy.delay.noData}</p>
          {reason === null || reason === "no-stops" ? null : (
            <p className="type-caption text-ink-muted">{copy.stats.empty[reason]}</p>
          )}
        </>
      ) : (
        <>
          <p className="flex items-baseline gap-1">
            <span className="type-display text-[34px]" data-testid="punctual6">
              <NumberText value={percentNumber(summary.punctual6)} digits={1} />
            </span>
            <span className="type-body-strong text-ink-muted">{percentSign(locale)}</span>
          </p>
          <p className="type-caption text-ink-muted">{copy.stats.punctual.rule}</p>
        </>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0">
      <dt className="type-body min-w-0 text-ink-muted">{label}</dt>
      <dd className="type-data m-0 shrink-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function Missing() {
  const copy = useStatsCopy();
  return <span className="type-body font-normal text-ink-muted">{copy.delay.noData}</span>;
}

export function Facts({ summary, runs }: { summary: StatsSummary; runs?: number }) {
  const copy = useStatsCopy();
  const count = (value: number) => <NumberText value={value} />;
  const delay = (seconds: number | null) =>
    seconds === null ? (
      <Missing />
    ) : (
      <Duration seconds={seconds} minutesWord={copy.delay.minutes} />
    );
  const share = (value: number | null) =>
    value === null ? <Missing /> : <Percent share={value} />;
  return (
    <dl className="m-0 flex flex-col" data-slot="facts">
      {runs === undefined ? null : <Row label={copy.stats.fact.runs}>{count(runs)}</Row>}
      <Row label={copy.stats.punctual.rule16}>{share(summary.punctual16)}</Row>
      <Row label={copy.stats.fact.observedArrivals}>{count(summary.observedArrivals)}</Row>
      <Row label={copy.stats.fact.cancelled}>
        {count(summary.cancelled)}
        {summary.cancelledShare === null ? null : (
          <span className="type-caption ml-2 font-normal text-ink-muted">
            <Percent share={summary.cancelledShare} />
          </span>
        )}
      </Row>
      <Row label={copy.stats.fact.mean}>{delay(summary.meanDelayS)}</Row>
      <Row label={copy.stats.fact.median}>{delay(summary.medianDelayS)}</Row>
      <Row label={copy.stats.fact.p90}>{delay(summary.p90DelayS)}</Row>
      <Row label={copy.stats.fact.max}>{delay(summary.maxDelayS)}</Row>
    </dl>
  );
}
