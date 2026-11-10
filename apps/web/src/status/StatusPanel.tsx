import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useFormatters } from "@gerlines/i18n/react";
import { useStatusCopy } from "@gerlines/i18n/status";
import { Button, ClockText, cn, Notice, PopoverTitle, Skeleton } from "@gerlines/ui";
import { Fragment } from "react";
import { useNow } from "../hooks/use-now.ts";
import { SOURCES_PATH, withLanguage } from "../legal/path.ts";
import { useAppStore } from "../state/store.ts";
import { useCooldown } from "../stats/use-cooldown.ts";
import { type Phrase, type StatusView, statusView } from "./model.ts";
import { StatusDot } from "./StatusDot.tsx";
import { type StatusLoad, useDataStatus } from "./use-data-status.ts";

/** The live line counts seconds, so the panel draws it again every second while open. */
const TICK_MS = 1_000;

function PhraseText({ phrase }: { phrase: Phrase }) {
  const at = phrase.figure === null ? -1 : phrase.text.indexOf(phrase.figure);
  if (phrase.figure === null || at < 0) return phrase.text;
  return (
    <>
      {phrase.text.slice(0, at)}
      <ClockText text={phrase.figure} className="type-data-small" />
      {phrase.text.slice(at + phrase.figure.length)}
    </>
  );
}

function Rows({ view }: { view: StatusView }) {
  return (
    <>
      {view.groups.map((group) => (
        <section key={group.kind} aria-label={group.title} className="flex flex-col gap-1.5">
          <h3 className="type-caption text-ink-muted">{group.title}</h3>
          <ul className="flex flex-col gap-2">
            {group.rows.map((row) => (
              <li key={row.id} data-source={row.id} data-state={row.state} className="flex gap-2">
                <StatusDot state={row.state} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="type-body-strong break-words">
                      {row.name}
                      {row.area ? (
                        <span className="font-normal text-ink-muted"> {row.area}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "type-caption",
                        row.state === "ok" ? "text-ink-muted" : "text-ink",
                      )}
                    >
                      {row.stateLabel}
                    </span>
                  </p>
                  {row.recorded || row.onMap ? (
                    <p className="type-caption text-ink-muted">
                      {[row.recorded, row.onMap]
                        .filter((phrase): phrase is Phrase => phrase !== null)
                        .map((phrase, index) => (
                          <Fragment key={phrase.text}>
                            {index > 0 ? ", " : null}
                            <PhraseText phrase={phrase} />
                          </Fragment>
                        ))}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The data status card: presentational, from one load state and the clocks of the live line. */
export function StatusPanelView({
  load,
  onRetry,
  now,
  mapFrameAt,
}: {
  load: StatusLoad;
  onRetry: () => void;
  now: number;
  mapFrameAt?: number | undefined;
}) {
  const { status } = useStatusCopy();
  const a11y = useA11yCopy();
  const format = useFormatters();
  const waiting = useCooldown(load.state === "failed" ? load.retryAfterS : undefined, load);
  const header = <PopoverTitle className="type-label">{status.title}</PopoverTitle>;
  if (load.state === "loading") {
    return (
      <>
        {header}
        <p className="type-caption text-ink-muted" aria-live="polite">
          {status.loading}
        </p>
        <Skeleton className="h-24" />
      </>
    );
  }
  if (load.state === "failed") {
    return (
      <>
        {header}
        <Notice
          tone="error"
          role="alert"
          action={
            load.kind === "not-configured" ? undefined : (
              <Button variant="quiet" disabled={waiting > 0} onClick={onRetry}>
                {waiting > 0 ? status.retryIn(waiting) : status.retry}
              </Button>
            )
          }
        >
          {load.kind === "not-configured" ? status.notConfigured : status.error}
        </Notice>
      </>
    );
  }
  const view = statusView(load.data, status, format, {
    now,
    answeredAt: load.answeredAt,
    mapFrameAt,
  });
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        {header}
        <span className="type-caption text-ink-muted">
          <PhraseText phrase={view.asOf} />
        </span>
      </div>
      <div data-slot="status-live" className="flex items-start gap-2">
        <StatusDot state={view.live.state} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="type-body-strong">{status.live.title}</span>
            <span
              className={cn(
                "type-caption",
                view.live.state === "ok" ? "text-ink-muted" : "text-ink",
              )}
            >
              {view.live.stateLabel}
            </span>
          </p>
          <p className="type-caption text-ink-muted">
            <PhraseText phrase={view.live.detail} />
          </p>
        </div>
      </div>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling list needs a keyboard stop to be scrolled (WCAG 2.1.1)
        tabIndex={0}
        aria-label={a11y.sourceList}
        className="focus-ring flex max-h-[min(60dvh,420px)] flex-col gap-3 overflow-y-auto"
      >
        <Rows view={view} />
      </section>
      {load.refreshFailed ? (
        <p className="type-caption text-ink" role="status">
          {status.refreshFailed}
        </p>
      ) : null}
      {view.note ? <p className="type-caption text-ink-muted">{view.note}</p> : null}
      <a
        href={withLanguage(SOURCES_PATH)}
        className="type-caption self-start underline underline-offset-2"
      >
        {status.sourcesLink}
      </a>
    </>
  );
}

/** The popover body, loaded with its first opening. */
export default function StatusPanel() {
  const { load, retry } = useDataStatus();
  const now = useNow(TICK_MS);
  const mapFrameAt = useAppStore((state) => state.status.frameWallMs);
  return <StatusPanelView load={load} onRetry={retry} now={now} mapFrameAt={mapFrameAt} />;
}
