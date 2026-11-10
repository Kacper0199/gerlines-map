import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useLocale } from "@gerlines/i18n/react";
import { useStatsCopy } from "@gerlines/i18n/stats";
import {
  STATS_LAND_CODES,
  StatsLandCode,
  StatsLineName,
  StatsTrainNumber,
} from "@gerlines/schema/stats";
import { Button, cn, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@gerlines/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { type FetchLike, fetchSearch, searchQueryOf } from "../search/search-client.ts";
import { AREA_KINDS, type AreaKind, type StatsArea } from "./area.ts";
import { Field } from "./Field.tsx";
import { useStatsStore } from "./store.ts";
import { useLaender } from "./use-laender.ts";

const SEARCH_DEBOUNCE_MS = 250;
const VISIBLE_STATIONS = 6;

function isKind(value: unknown): value is AreaKind {
  return AREA_KINDS.some((kind) => kind === value);
}

const SELECT_CLASS =
  "focus-ring h-target w-full min-w-0 rounded-lg border border-hairline bg-raised px-3 text-ink hover:border-passed max-[640px]:h-11 max-[640px]:text-base";

function LandSelect({ code }: { code: StatsLandCode | null }) {
  const copy = useStatsCopy();
  const locale = useLocale();
  const setArea = useStatsStore((state) => state.setArea);
  const laender = useLaender();
  const names = new Map(laender.map((land) => [land.code, land.names[locale]]));
  const options = STATS_LAND_CODES.map((value) => ({
    value,
    name: names.get(value) ?? value,
  })).sort((a, b) => a.name.localeCompare(b.name, locale));
  return (
    <label className="type-label flex flex-col gap-1">
      {copy.stats.landLabel}
      <select
        className={cn(SELECT_CLASS, "type-body")}
        value={code ?? ""}
        onChange={(event) => {
          const parsed = StatsLandCode.safeParse(event.target.value);
          if (parsed.success) setArea({ kind: "land", code: parsed.data });
        }}
      >
        {code === null ? <option value="">{copy.stats.landPlaceholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface StationHit {
  readonly id: string;
  readonly name: string;
}

function useStationHits(text: string, fetch: FetchLike) {
  const locale = useLocale();
  const [state, setState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "error" }
    | { readonly kind: "ok"; readonly hits: readonly StationHit[] }
  >({ kind: "idle" });
  useEffect(() => {
    const query = searchQueryOf(text);
    if (query === null) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSearch(query, locale, { fetch, signal: controller.signal }).then(
        (answer) =>
          setState(
            answer.kind === "ok"
              ? {
                  kind: "ok",
                  hits: answer.results.flatMap((result) =>
                    result.kind === "station" ? [{ id: result.id, name: result.name }] : [],
                  ),
                }
              : { kind: "error" },
          ),
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, locale, fetch]);
  return state;
}

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function StationSearch() {
  const copy = useStatsCopy();
  const { results } = useA11yCopy();
  const setArea = useStatsStore((state) => state.setArea);
  const [text, setText] = useState("");
  const listId = useId();
  const answer = useStationHits(text, browserFetch);
  const choose = (hit: StationHit) => {
    setArea({ kind: "station", id: hit.id, name: hit.name });
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={copy.stats.station.label}>
        {(id) => (
          <Input
            id={id}
            type="search"
            value={text}
            placeholder={copy.stats.station.placeholder}
            aria-controls={listId}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      <div role="status" aria-live="polite">
        {answer.kind === "loading" ? (
          <p className="type-caption text-ink-muted">{copy.search.loading}</p>
        ) : null}
        {answer.kind === "error" ? (
          <p className="type-caption text-ink">{copy.search.error}</p>
        ) : null}
        {answer.kind === "ok" && answer.hits.length === 0 ? (
          <p className="type-caption text-ink-muted">{copy.stats.station.none}</p>
        ) : null}
        {answer.kind === "ok" && answer.hits.length > 0 ? (
          <span className="sr-only">{results(Math.min(answer.hits.length, VISIBLE_STATIONS))}</span>
        ) : null}
      </div>
      <div id={listId}>
        {answer.kind === "ok" && answer.hits.length > 0 ? (
          <ul className="flex flex-col">
            {answer.hits.slice(0, VISIBLE_STATIONS).map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="focus-ring type-body min-h-target w-full rounded-md px-2 text-left hover:bg-raised max-[640px]:min-h-11"
                  onClick={() => choose(hit)}
                >
                  {hit.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function TextTarget({ kind, value }: { kind: "line" | "train"; value: string }) {
  const copy = useStatsCopy();
  const setArea = useStatsStore((state) => state.setArea);
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(value), [value]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "train") {
      const parsed = StatsTrainNumber.safeParse(text);
      setInvalid(!parsed.success);
      if (parsed.success) setArea({ kind: "train", number: parsed.data });
      return;
    }
    const parsed = StatsLineName.safeParse(text);
    setInvalid(!parsed.success);
    if (parsed.success) setArea({ kind: "line", name: parsed.data });
  };
  const label = kind === "train" ? copy.stats.trainLabel : copy.stats.lineLabel;
  return (
    <form className="flex flex-col gap-1" onSubmit={submit}>
      <Field label={label}>
        {(id) => (
          <span className="flex gap-2">
            <Input
              id={id}
              value={text}
              aria-invalid={invalid}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
            />
            <Button type="submit" variant="secondary">
              {copy.stats.show}
            </Button>
          </span>
        )}
      </Field>
      {invalid ? (
        <p role="alert" className="type-caption text-ink">
          {kind === "train" ? copy.stats.trainInvalid : copy.stats.lineInvalid}
        </p>
      ) : (
        <p className="type-caption text-ink-muted">
          {kind === "train" ? copy.stats.trainHint : copy.stats.lineHint}
        </p>
      )}
    </form>
  );
}

function AreaFields({ kind, area }: { kind: AreaKind; area: StatsArea | null }) {
  switch (kind) {
    case "land":
      return <LandSelect code={area?.kind === "land" ? area.code : null} />;
    case "station":
      return <StationSearch />;
    case "train":
      return <TextTarget kind="train" value={area?.kind === "train" ? area.number : ""} />;
    case "line":
      return <TextTarget kind="line" value={area?.kind === "line" ? area.name : ""} />;
    case "network":
      return null;
  }
}

/**
 * The area tabs and the field of the chosen area. On the desktop panel the tabs go into the
 * sticky head through `tabsHost`, so they stay in reach while the results scroll: `null` while
 * that host is not mounted yet, `undefined` to keep them in place (phone sheet).
 */
export function AreaPicker({ tabsHost }: { tabsHost?: HTMLElement | null | undefined }) {
  const copy = useStatsCopy();
  const kind = useStatsStore((state) => state.kind);
  const area = useStatsStore((state) => state.area);
  const setKind = useStatsStore((state) => state.setKind);
  const list = (
    <TabsList
      aria-label={copy.stats.area.label}
      className="flex-wrap gap-x-1 gap-y-0 overflow-visible"
    >
      {AREA_KINDS.map((entry) => (
        <TabsTrigger key={entry} value={entry} className="px-1.5">
          {copy.stats.area[entry]}
        </TabsTrigger>
      ))}
    </TabsList>
  );
  return (
    <div className="flex flex-col gap-2" data-slot="area-picker">
      <Tabs
        value={kind}
        onValueChange={(value) => {
          if (isKind(value)) setKind(value);
        }}
      >
        {tabsHost === undefined ? list : tabsHost === null ? null : createPortal(list, tabsHost)}
        {AREA_KINDS.map((entry) => (
          <TabsContent
            key={entry}
            value={entry}
            tabIndex={-1}
            className="flex-none text-base outline-none"
          >
            <AreaFields kind={entry} area={area} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
