import { useJourneysCopy } from "@gerlines/i18n/journeys";
import { Button, CategoryMark, Checkbox, Input, ToggleGroup, ToggleGroupItem } from "@gerlines/ui";
import { ArrowDownUp, ChevronDown, Search } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { berlinLocalOf } from "./berlin-time.ts";
import { type FormProblem, type PlannerStation, usePlannerStore } from "./planner-store.ts";
import { PLANNER_CATEGORIES } from "./planner-url.ts";
import { StationField } from "./StationField.tsx";

function useProblemText(problem: FormProblem | null): string | null {
  const { journeys } = useJourneysCopy();
  switch (problem) {
    case "stations":
      return journeys.needStations;
    case "same":
      return journeys.sameStation;
    case "categories":
      return journeys.categoryNone;
    default:
      return null;
  }
}

/** A raised fill with ink text when chosen, so Find journeys stays the one solid button. */
const TIME_MODE_ITEM = "min-h-target flex-1 aria-pressed:bg-raised aria-pressed:text-ink";

function TimeRow() {
  const copy = useJourneysCopy();
  const time = usePlannerStore((state) => state.time);
  const arriveBy = usePlannerStore((state) => state.arriveBy);
  const setTime = usePlannerStore((state) => state.setTime);
  const setArriveBy = usePlannerStore((state) => state.setArriveBy);
  const timeId = useId();
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label={copy.journeys.timeMode}
        value={[arriveBy ? "arrive" : "depart"]}
        onValueChange={(value) => {
          if (value.length > 0) setArriveBy(value[0] === "arrive");
        }}
        className="w-full shadow-none"
      >
        <ToggleGroupItem value="depart" className={TIME_MODE_ITEM}>
          {copy.journeys.depart}
        </ToggleGroupItem>
        <ToggleGroupItem value="arrive" className={TIME_MODE_ITEM}>
          {copy.journeys.arrive}
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={timeId} className="type-label text-ink-muted">
            {copy.journeys.time}
          </label>
          <Input
            id={timeId}
            type="datetime-local"
            value={time ?? berlinLocalOf(Date.now())}
            onChange={(event) => setTime(event.currentTarget.value || null)}
            className="num [color-scheme:light_dark]"
          />
        </div>
        <Button
          type="button"
          variant="quiet"
          aria-pressed={time === null}
          onClick={() => setTime(null)}
        >
          {copy.journeys.now}
        </Button>
      </div>
    </div>
  );
}

function CategoryChoice() {
  const copy = useJourneysCopy();
  const categories = usePlannerStore((state) => state.categories);
  const toggle = usePlannerStore((state) => state.toggleCategory);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="type-label mb-1 text-ink-muted">{copy.journeys.categories}</legend>
      <div className="grid grid-cols-2 gap-x-3">
        {PLANNER_CATEGORIES.map((category) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox renders the control inside the label
          <label key={category} className="flex min-h-target cursor-pointer items-center gap-2">
            <Checkbox
              checked={categories.includes(category)}
              onCheckedChange={() => toggle(category)}
            />
            <CategoryMark category={category} size={10} />
            <span className="type-body wrap-break-word text-ink">
              {copy.categories[category].legend}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function filtersSummary(
  copy: ReturnType<typeof useJourneysCopy>["journeys"],
  kinds: number,
  operator: string,
): string {
  const trimmed = operator.trim();
  if (kinds === PLANNER_CATEGORIES.length && trimmed === "") return copy.filtersAll;
  const parts = [
    kinds === PLANNER_CATEGORIES.length ? null : copy.filtersKinds(kinds),
    trimmed || null,
  ];
  return parts.filter(Boolean).join(", ");
}

function Filters({ forceOpen }: { forceOpen: boolean }) {
  const copy = useJourneysCopy();
  const kinds = usePlannerStore((state) => state.categories.length);
  const operator = usePlannerStore((state) => state.operator);
  const setOperator = usePlannerStore((state) => state.setOperator);
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  const panelId = useId();
  const operatorId = useId();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={panelId}
        onClick={() => setOpen(!shown)}
        className="focus-ring -mx-2 flex min-h-target items-center justify-between gap-3 rounded-lg px-2 text-left hover:bg-raised"
      >
        <span className="flex min-w-0 flex-col">
          <span className="type-label text-ink">{copy.journeys.filters}</span>
          <span className="type-caption wrap-break-word text-ink-muted">
            {filtersSummary(copy.journeys, kinds, operator)}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={
            shown ? "size-4 shrink-0 rotate-180 text-ink-muted" : "size-4 shrink-0 text-ink-muted"
          }
        />
      </button>
      <div id={panelId} hidden={!shown} className="flex flex-col gap-3">
        <CategoryChoice />
        <div className="flex flex-col gap-1">
          <label htmlFor={operatorId} className="type-label text-ink-muted">
            {copy.journeys.operator}
          </label>
          <Input
            id={operatorId}
            value={operator}
            maxLength={40}
            placeholder={copy.journeys.operatorPlaceholder}
            aria-describedby={hintId}
            onChange={(event) => setOperator(event.currentTarget.value)}
          />
          <span id={hintId} className="type-caption text-ink-muted">
            {copy.journeys.operatorHint}
          </span>
        </div>
      </div>
    </div>
  );
}

/** From and to, depart or arrive time, the trains to use and an operator, then Find journeys. */
export function PlannerForm() {
  const copy = useJourneysCopy();
  const from = usePlannerStore((state) => state.from);
  const to = usePlannerStore((state) => state.to);
  const problem = usePlannerStore((state) => state.problem);
  const loading = usePlannerStore((state) => state.results.status === "loading");
  const setFrom = usePlannerStore((state) => state.setFrom);
  const setTo = usePlannerStore((state) => state.setTo);
  const swap = usePlannerStore((state) => state.swap);
  const search = usePlannerStore((state) => state.search);
  const problemText = useProblemText(problem);
  const missing = problem === "stations";
  const noStop = (station: PlannerStation | null) =>
    problem === "noStopId" && station !== null && station.stopId === null
      ? copy.journeys.noStopId(station.name)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void search();
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 px-4"
      data-slot="planner-form"
      noValidate
    >
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <StationField
            label={copy.journeys.from}
            placeholder={copy.journeys.fromPlaceholder}
            value={from}
            onChange={setFrom}
            invalid={missing && from === null}
            error={noStop(from)}
          />
          <StationField
            label={copy.journeys.to}
            placeholder={copy.journeys.toPlaceholder}
            value={to}
            onChange={setTo}
            invalid={(missing && to === null) || problem === "same"}
            error={noStop(to)}
          />
        </div>
        <Button
          type="button"
          variant="quiet"
          size="icon"
          aria-label={copy.journeys.swap}
          onClick={swap}
          className="mb-8"
        >
          <ArrowDownUp aria-hidden="true" />
        </Button>
      </div>
      <TimeRow />
      <Filters forceOpen={problem === "categories"} />
      <p role="alert" className={problemText ? "type-body text-ink" : "sr-only"}>
        {problemText ?? ""}
      </p>
      <Button type="submit" variant="solid" loading={loading} className="self-stretch">
        <Search aria-hidden="true" />
        {loading ? copy.journeys.searching : copy.journeys.search}
      </Button>
    </form>
  );
}
