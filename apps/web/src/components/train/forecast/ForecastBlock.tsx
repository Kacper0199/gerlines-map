import { LOCALE_TAGS } from "@gerlines/i18n";
import { type PredictCopy, usePredictCopy } from "@gerlines/i18n/predict";
import { useLocale } from "@gerlines/i18n/react";
import { delayChipText } from "@gerlines/ui";
import type { ForecastModel } from "./forecast-model.ts";

const SOURCE_LINK = "focus-ring rounded-sm underline decoration-1 underline-offset-2";

function monthOf(month: string, locale: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1));
}

function basisNote(forecast: ForecastModel, predict: PredictCopy, locale: string): string {
  const from = monthOf(forecast.trainedFrom, locale);
  const to = monthOf(forecast.trainedTo, locale);
  if (forecast.feedSourceName === null) return `${predict.note(from, to)} ${predict.method}`;
  const rest = forecast.historyRows ? ` ${predict.noteRest}` : "";
  return `${predict.noteFeed(forecast.feedSourceName, from, to)}${rest} ${predict.methodFeed}`;
}

export function ForecastBlock({ forecast }: { forecast: ForecastModel }) {
  const copy = usePredictCopy();
  const predict = copy.predict;
  const locale = LOCALE_TAGS[useLocale()];
  const minutes = (value: number) => `${delayChipText(value)} ${copy.delay.minutes}`;
  const title = forecast.feedSourceName === null ? predict.title : predict.titleFeed;
  return (
    <section aria-label={title} className="flex flex-col gap-2 border-t px-4 pt-3 pb-3">
      <h3 className="type-label text-ink-muted">{title}</h3>
      <p className="type-caption text-ink-muted">
        {predict.from(minutes(forecast.fromDelayMinutes), forecast.fromName)}
      </p>
      <ul className="flex flex-col gap-1.5">
        {forecast.rows.map((row) => (
          <li key={row.index} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span className="type-body break-words">{row.name}</span>
              <span className="type-caption text-ink-muted">
                {row.basis === "feed_plus_spread"
                  ? predict.spread[row.level]
                  : predict.level[row.level]}
              </span>
            </span>
            <span className="num type-data-small shrink-0 text-right">
              {predict.value(minutes(row.expectedMinutes), minutes(row.upperMinutes))}
            </span>
          </li>
        ))}
      </ul>
      {forecast.more > 0 ? (
        <p className="type-caption text-ink-muted">{predict.more(forecast.more)}</p>
      ) : null}
      <p className="type-caption text-ink-muted">
        {basisNote(forecast, predict, locale)}{" "}
        {predict.source(predict.attribution(forecast.sourceName, forecast.attribution))}{" "}
        {predict.licence}{" "}
        {forecast.licence.url ? (
          <a
            href={forecast.licence.url}
            className={SOURCE_LINK}
            target="_blank"
            rel="license noreferrer"
          >
            {forecast.licence.id}
          </a>
        ) : (
          forecast.licence.id
        )}
        .
      </p>
    </section>
  );
}
