import { useFormatters } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import type { StatsFreshness, StatsNetwork } from "@gerlines/schema/stats";
import { ChevronDown } from "lucide-react";
import { coversWholeMonths } from "./periods.ts";
import type { StatsData } from "./stats-client.ts";

function Outside({ foreign, unassigned }: { foreign: number; unassigned: number }) {
  const copy = useStatsCopy();
  const { count } = useFormatters();
  if (foreign === 0 && unassigned === 0) return null;
  if (unassigned === 0) return <p>{copy.stats.method.outsideForeign(count(foreign))}</p>;
  if (foreign === 0) return <p>{copy.stats.method.outsideUnassigned(count(unassigned))}</p>;
  return <p>{copy.stats.method.outside(count(foreign), count(unassigned))}</p>;
}

function Method({ data }: { data: StatsData }) {
  const copy = useStatsCopy();
  const { count } = useFormatters();
  const network = data.kind === "network" ? (data as StatsNetwork) : null;
  const summary = "summary" in data ? data.summary : null;
  const estimated = summary === null ? 0 : summary.observedCarried + summary.observedPropagated;
  return (
    <details className="group/method type-caption text-ink-muted">
      <summary className="focus-ring type-label flex min-h-target cursor-pointer list-none items-center justify-between gap-2 rounded-md py-2 text-ink marker:hidden [&::-webkit-details-marker]:hidden">
        {copy.stats.method.title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-ink-muted transition-transform group-open/method:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-2 pb-2">
        <p>{copy.stats.method.rule}</p>
        {network !== null && coversWholeMonths(network.period) ? (
          <p>{copy.stats.method.gap}</p>
        ) : null}
        {network === null ? null : (
          <Outside
            foreign={network.outsideGermany.foreignStops}
            unassigned={network.outsideGermany.unassignedStops}
          />
        )}
        {estimated > 0 ? <p>{copy.stats.method.estimated(count(estimated))}</p> : null}
        <p>{copy.stats.method.history}</p>
      </div>
    </details>
  );
}

export function Provenance({ data }: { data: StatsData }) {
  const copy = useStatsCopy();
  const { clock, day } = useFormatters();
  const freshness: StatsFreshness = data.freshness;
  const refreshed =
    freshness.refreshedAt === null
      ? copy.stats.provenance.refreshedUnknown
      : copy.stats.provenance.refreshed(
          clock(Date.parse(freshness.refreshedAt)),
          day(Date.parse(freshness.refreshedAt)),
        );
  return (
    <footer className="flex flex-col gap-1 border-t pt-3" data-slot="provenance">
      <p className="type-caption text-ink-muted">{copy.stats.provenance.source}</p>
      <p className="type-caption text-ink-muted">{refreshed}</p>
      <p className="type-caption text-ink-muted">
        {copy.stats.provenance.lag(freshness.maxLagMinutes)}
      </p>
      <Method data={data} />
    </footer>
  );
}
