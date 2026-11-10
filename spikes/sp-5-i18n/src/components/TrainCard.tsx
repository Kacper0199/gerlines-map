import { useCopy, useFormatters } from "@gerlines/i18n/react";
import { useState } from "react";
import { sample } from "../sample.ts";
import { Clock } from "./Clock.tsx";

const MINUTE_MS = 60_000;

export function TrainCard() {
  const copy = useCopy();
  const { clock, day } = useFormatters();
  const [expanded, setExpanded] = useState(false);
  const { train } = sample;
  const stop = train.nextStop;
  const minutes = Math.max(0, Math.ceil((stop.arrivalMs - sample.capturedMs) / MINUTE_MS));

  return (
    <section className="card train" aria-label={copy.card.label}>
      <header>
        <p className="badge" data-cat={train.category}>
          {copy.categories[train.category].badge}
        </p>
        <h2>
          <span className="num">{train.line}</span> {train.destination}
        </h2>
        <p className="muted">
          {copy.card.from} {train.origin}
        </p>
      </header>
      <p className="delay">
        <span className="num big">+{train.delayMinutes}</span>
        <span className="unit">{copy.delay.minutes}</span>
        <span className="tag">{copy.card.realtime}</span>
      </p>
      <h3>{copy.card.nextStop}</h3>
      <p className="stop-name">{stop.name}</p>
      <p className="times">
        <Clock text={clock(stop.arrivalMs)} className="big" />
        <s className="muted">
          <Clock text={clock(stop.scheduledArrivalMs)} />
        </s>
      </p>
      <p>{copy.card.platformChanged(stop.platform, stop.scheduledPlatform)}</p>
      <p className="muted">{copy.card.toNextStop(minutes)}</p>
      <button
        type="button"
        className="more"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((open) => !open);
        }}
      >
        {expanded ? copy.card.collapse : copy.card.expand}
      </button>
      {expanded && (
        <>
          <dl className="facts">
            <dt>{copy.card.operator}</dt>
            <dd>{train.operator}</dd>
          </dl>
          <div className="notes">
            <p>{copy.card.departsAt(clock(stop.departureMs))}</p>
            <p>{copy.card.positionEstimated}</p>
            <p>{copy.card.dataFrom(clock(sample.capturedMs), day(sample.capturedMs))}</p>
          </div>
        </>
      )}
    </section>
  );
}
