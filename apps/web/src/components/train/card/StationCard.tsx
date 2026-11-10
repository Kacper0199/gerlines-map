import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { Badge, Button, DelayValue, SoonTag, TimePair } from "@gerlines/ui";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { type StopRow, type StopTimes, timeOf } from "../model.ts";
import { PlatformText } from "./StopStrip.tsx";

function TimeLine({
  label,
  times,
  delayMinutes,
}: {
  label: string;
  times: StopTimes;
  delayMinutes: number | null;
}) {
  const copy = useCopy();
  const { clock } = useFormatters();
  const shown = timeOf(times);
  if (shown === null) {
    return null;
  }
  const scheduled =
    times.predictedMs !== null && times.scheduledMs !== null ? clock(times.scheduledMs) : undefined;
  const struck = scheduled !== undefined && scheduled !== clock(shown);
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="type-body text-ink-muted">{label}</dt>
      <dd className="flex items-start gap-3">
        {struck || delayMinutes === null ? null : (
          <DelayValue
            minutes={delayMinutes}
            labels={copy.delay}
            size="inline"
            className="type-body text-ink-muted"
          />
        )}
        <TimePair
          size="row"
          predicted={clock(shown)}
          scheduled={scheduled}
          predictedLabel={times.predictedMs !== null ? copy.train.expected : copy.train.scheduled}
          scheduledLabel={copy.train.scheduled}
        />
      </dd>
    </div>
  );
}

export function StationCard({
  stop,
  trainName,
  onBack,
  closeSlot,
  headingId,
}: {
  stop: StopRow;
  trainName: string;
  onBack: () => void;
  closeSlot: ReactNode;
  headingId?: string;
}) {
  const copy = useCopy();
  const train = copy.train;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex min-h-target items-center justify-between gap-2 px-4">
        <Button variant="quiet" className="-ml-3 min-w-0" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          <span className="truncate">{train.station.back(trainName)}</span>
        </Button>
        {closeSlot}
      </div>
      <header className="flex flex-col gap-1 px-4">
        <span className="type-label text-ink-muted">{train.station.label}</span>
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="type-headline wrap-break-word text-[24px] outline-none sm:text-[28px]"
        >
          {stop.name}
        </h2>
      </header>
      <section
        className="flex flex-col gap-2 border-t px-4 pt-3"
        aria-label={train.station.thisTrain}
      >
        <div className="flex min-h-6 items-center justify-between gap-2">
          <h3 className="type-label text-ink-muted">{train.station.thisTrain}</h3>
          {stop.cancelled ? <Badge variant="error">{train.stopCancelled}</Badge> : null}
        </div>
        <dl className="flex flex-col gap-2">
          <TimeLine
            label={train.arrival}
            times={stop.arrival}
            delayMinutes={stop.cancelled ? null : stop.arrivalDelayMinutes}
          />
          <TimeLine
            label={train.departure}
            times={stop.departure}
            delayMinutes={stop.cancelled ? null : stop.departureDelayMinutes}
          />
        </dl>
        {stop.platform ? (
          <p className="type-body-strong">
            <PlatformText platform={stop.platform} />
          </p>
        ) : null}
      </section>
      <section className="flex items-center justify-between gap-2 border-t px-4 pt-3">
        <h3 className="type-label text-ink-muted">{train.station.board}</h3>
        <SoonTag label={copy.soon.tag} description={copy.soon.description} />
      </section>
    </div>
  );
}
