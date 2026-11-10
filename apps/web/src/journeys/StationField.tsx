import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useJourneysCopy } from "@gerlines/i18n/journeys";
import { useLocale } from "@gerlines/i18n/react";
import type { SearchLocale, SearchStation } from "@gerlines/schema/search";
import { cn, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@gerlines/ui";
import { TrainFront, XIcon } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { nextActive } from "../search/SearchBox.tsx";
import type { FetchLike } from "../search/search-client.ts";
import { useSearch } from "../search/use-search.ts";
import { journeyStopIdOf, plannerStationOf } from "./planner-address.ts";
import type { PlannerStation } from "./planner-store.ts";

const MAX_OPTIONS = 6;

function StationStatus({
  status,
  query,
  count,
}: {
  status: "loading" | "error" | "ready" | "idle";
  query: string;
  count: number;
}) {
  const { journeys } = useJourneysCopy();
  const { results } = useA11yCopy();
  const empty = count === 0;
  const text =
    status === "error"
      ? journeys.stationError
      : status === "loading" && empty
        ? journeys.stationLoading
        : status === "ready" && empty
          ? journeys.stationNone(query)
          : null;
  if (text === null) {
    return status === "ready" && !empty ? <span className="sr-only">{results(count)}</span> : null;
  }
  return <p className="type-body wrap-break-word px-3 py-2 text-ink-muted">{text}</p>;
}

/**
 * One end of the journey: a combobox over the station search (WP-4.7) that offers stations only.
 * Arrow keys move through them, Enter takes the active one or the first in the journey timetable,
 * Escape closes the list. A station the journey timetable lacks is listed, muted and marked.
 */
export function StationField({
  label,
  placeholder,
  value,
  onChange,
  invalid = false,
  error = null,
  fetch,
}: {
  label: string;
  placeholder: string;
  value: PlannerStation | null;
  onChange: (station: PlannerStation | null) => void;
  invalid?: boolean;
  /** Says what is wrong with the chosen station, under the field. */
  error?: string | null;
  fetch?: FetchLike;
}) {
  const copy = useJourneysCopy();
  const locale = useLocale() as SearchLocale;
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const inputId = useId();
  const errorId = useId();
  const typed = text ?? value?.name ?? "";
  const state = useSearch(text ?? "", locale, 0, fetch ? { fetch } : {});
  const stations = useMemo(
    () =>
      state.status === "ready"
        ? state.results
            .filter((result): result is SearchStation => result.kind === "station")
            .slice(0, MAX_OPTIONS)
        : [],
    [state],
  );
  const expanded = open && text !== null && state.status !== "idle";

  const choose = (station: SearchStation) => {
    if (journeyStopIdOf(station) === null) return;
    onChange(plannerStationOf(station));
    setText(null);
    setOpen(false);
    setActive(-1);
  };

  const takeActive = () => {
    const pick =
      active >= 0 ? stations[active] : stations.find((item) => journeyStopIdOf(item) !== null);
    if (pick) choose(pick);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { key } = event;
    if ((key === "ArrowDown" || key === "ArrowUp") && stations.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => nextActive(key, index, stations.length));
    } else if (key === "Enter" && expanded && stations.length > 0) {
      event.preventDefault();
      takeActive();
    } else if (key === "Escape" && expanded) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={inputId} className="type-label text-ink-muted">
        {label}
      </label>
      <InputGroup className="min-w-0">
        <InputGroupAddon>
          <TrainFront aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          id={inputId}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          placeholder={placeholder}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setActive(-1);
            setOpen(true);
            if (value !== null) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setText(null);
          }}
          onKeyDown={onKeyDown}
          className="pl-10 text-ellipsis"
        />
        {typed !== "" ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={copy.search.clear}
              onClick={() => {
                setText("");
                onChange(null);
              }}
            >
              <XIcon aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {error !== null ? (
        <p id={errorId} className="type-caption wrap-break-word text-ink">
          {error}
        </p>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keeps the focus on the field while an option is pressed */}
      <div
        className={cn(
          "absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-hairline bg-surface py-1 shadow-card",
          !expanded && "hidden",
        )}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div role="status" aria-live="polite">
          {expanded ? (
            <StationStatus status={state.status} query={typed} count={stations.length} />
          ) : null}
        </div>
        <div id={listId} role="listbox" aria-label={copy.journeys.stationResults}>
          {stations.map((station, index) => {
            const routable = journeyStopIdOf(station) !== null;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: combobox pattern, the keys stay on the input
              <div
                key={station.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={!routable || undefined}
                tabIndex={-1}
                onClick={() => choose(station)}
                onMouseMove={() => setActive(index)}
                className={cn(
                  "flex min-h-target cursor-pointer flex-col justify-center px-3 py-1 aria-disabled:cursor-not-allowed",
                  index === active && "bg-raised shadow-[inset_3px_0_0_var(--gl-focus)]",
                )}
              >
                <span
                  className={cn(
                    "type-body-strong wrap-break-word",
                    routable ? "text-ink" : "text-ink-muted",
                  )}
                >
                  {station.name}
                </span>
                {!routable ? (
                  <span className="type-caption wrap-break-word text-ink-muted">
                    {copy.journeys.stationNoStop}
                  </span>
                ) : station.lines.length > 0 ? (
                  <span className="type-caption wrap-break-word text-ink-muted">
                    {station.lines.slice(0, 5).join(", ")}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
