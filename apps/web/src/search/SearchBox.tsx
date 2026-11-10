import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useCopy, useFormatters, useLocale } from "@gerlines/i18n/react";
import type { SearchLocale, SearchResult } from "@gerlines/schema/search";
import {
  Button,
  CategoryMark,
  cn,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@gerlines/ui";
import { MapPin, SearchIcon, TrainFront, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShortcutsStore } from "../a11y/shortcuts.ts";
import { useNow } from "../hooks/use-now.ts";
import { chooseResult } from "./choose.ts";
import {
  categoryKeyOf,
  flatOrder,
  groupResults,
  type ResultGroup,
  trainTimingOf,
  trainTitleOf,
} from "./result-view.ts";
import { type FetchLike, searchQueryOf } from "./search-client.ts";
import { useFittingPlaceholder } from "./use-fitting-placeholder.ts";
import { useRetryWait } from "./use-retry-wait.ts";
import { type SearchState, useSearch } from "./use-search.ts";

const VISIBLE_LINES = 5;
const NO_RESULTS: readonly SearchResult[] = [];

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** `/` focuses the search field from anywhere outside another field. */
function useSlashShortcut(input: React.RefObject<HTMLInputElement | null>): void {
  const enabled = useShortcutsStore((state) => state.enabled);
  useEffect(() => {
    if (!enabled) return;
    const focus = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, [input, enabled]);
}

function ResultIcon({ result }: { result: SearchResult }) {
  if (result.kind === "train") {
    return <CategoryMark category={categoryKeyOf(result.category, result.foreign)} size={12} />;
  }
  if (result.kind === "line")
    return <CategoryMark category={categoryKeyOf(result.category)} size={12} />;
  if (result.kind === "station") return <TrainFront aria-hidden="true" className="size-4" />;
  return <MapPin aria-hidden="true" className="size-4" />;
}

function useResultText(nowMs: number) {
  const copy = useCopy();
  const { clock } = useFormatters();
  const search = copy.search;
  return (result: SearchResult): { title: string; detail: readonly string[] } => {
    switch (result.kind) {
      case "train": {
        const timing = trainTimingOf(result, nowMs);
        const when =
          timing === "running"
            ? search.trainRunning(clock(Date.parse(result.arrival)))
            : timing === "later"
              ? search.trainDeparts(clock(Date.parse(result.departure)))
              : search.trainArrived(clock(Date.parse(result.arrival)));
        return {
          title: trainTitleOf(result, search.trainNumber),
          detail: [search.trainRoute(result.origin.name, result.destination.name), when],
        };
      }
      case "line":
        return {
          title: result.line,
          detail: [
            [result.operator, search.trainsToday(result.trainsToday)].filter(Boolean).join(", "),
          ],
        };
      case "station":
        return {
          title: result.name,
          detail: [
            [
              result.lines.slice(0, VISIBLE_LINES).join(", "),
              search.trainsToday(result.trainsToday),
            ]
              .filter(Boolean)
              .join(", "),
          ],
        };
      case "place":
        return {
          title: result.name,
          detail: [result.type === "land" ? search.land : (result.region ?? "")].filter(Boolean),
        };
    }
  };
}

function StatusLine({
  state,
  hasResults,
  waiting,
  onRetry,
}: {
  state: SearchState;
  hasResults: boolean;
  waiting: boolean;
  onRetry: () => void;
}) {
  const { search } = useCopy();
  const { retryKey } = useA11yCopy();
  if (state.status === "error") {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <p className="type-body text-ink">{search.error}</p>
        {waiting ? null : <span className="sr-only">{retryKey}</span>}
        <Button variant="secondary" loading={waiting} onClick={onRetry}>
          {search.retry}
        </Button>
      </div>
    );
  }
  if (state.status === "loading" && !hasResults) {
    return <p className="type-body px-4 py-2 text-ink-muted">{search.loading}</p>;
  }
  if (state.status === "ready" && !hasResults) {
    return (
      <p className="type-body wrap-break-word px-4 py-2 text-ink">{search.empty(state.query)}</p>
    );
  }
  return null;
}

/** The next active option for an arrow key, wrapping at both ends. */
export function nextActive(key: "ArrowDown" | "ArrowUp", index: number, length: number): number {
  const last = length - 1;
  if (key === "ArrowDown") return index < 0 || index >= last ? 0 : index + 1;
  return index <= 0 ? last : index - 1;
}

function ResultOption({
  id,
  result,
  active,
  text,
  onChoose,
  onHover,
}: {
  id: string;
  result: SearchResult;
  active: boolean;
  text: { title: string; detail: readonly string[] };
  onChoose: () => void;
  onHover: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: combobox pattern, the keys stay on the input (aria-activedescendant)
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onChoose}
      onMouseMove={onHover}
      className={cn(
        "flex min-h-target cursor-pointer items-start gap-3 px-4 py-2",
        active && "bg-raised shadow-[inset_3px_0_0_var(--gl-focus)]",
      )}
    >
      <span className="mt-1 flex size-4 shrink-0 items-center justify-center text-ink-muted">
        <ResultIcon result={result} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="type-body-strong wrap-break-word text-ink">{text.title}</span>
        {text.detail.map((line) => (
          <span key={line} className="type-caption wrap-break-word text-ink-muted">
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}

function ResultList({
  listId,
  groups,
  active,
  textOf,
  onChoose,
  onHover,
  stale,
}: {
  listId: string;
  groups: readonly ResultGroup[];
  active: number;
  stale: boolean;
  textOf: (result: SearchResult) => { title: string; detail: readonly string[] };
  onChoose: (result: SearchResult) => void;
  onHover: (index: number) => void;
}) {
  const copy = useCopy();
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={copy.search.results}
      aria-busy={stale}
      className={cn("transition-opacity", stale && "opacity-60")}
    >
      {groups.map((group) => (
        // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group, a fieldset would not belong to the listbox
        <div
          key={group.kind}
          role="group"
          aria-labelledby={`${listId}-${group.kind}`}
          className="py-1"
        >
          <div id={`${listId}-${group.kind}`} className="type-label px-4 py-1 text-ink-muted">
            {copy.search.groups[group.kind]}
          </div>
          {group.results.map(({ result, index }) => (
            <ResultOption
              key={`${result.kind}:${result.id}`}
              id={`${listId}-option-${index}`}
              result={result}
              active={index === active}
              text={textOf(result)}
              onChoose={() => onChoose(result)}
              onHover={() => onHover(index)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  const copy = useCopy();
  return (
    <InputGroupAddon align="inline-end">
      <InputGroupButton aria-label={copy.search.clear} onClick={onClear}>
        <XIcon aria-hidden="true" />
      </InputGroupButton>
    </InputGroupAddon>
  );
}

/**
 * The search field of the shell as a combobox: results grouped by kind under the field, arrow keys
 * move through them, Enter picks the active one (or the first), Escape closes the list and then
 * clears the field, and the slash key focuses the field from anywhere.
 */
export function SearchBox({
  placeholder,
  fetch,
  endSlot,
  className,
}: {
  placeholder: string | readonly [string, ...string[]];
  fetch?: FetchLike;
  endSlot?: ReactNode;
  className?: string;
}) {
  const copy = useCopy();
  const a11y = useA11yCopy();
  const locale = useLocale() as SearchLocale;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hovered, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shownPlaceholder = useFittingPlaceholder(
    input,
    typeof placeholder === "string" ? [placeholder] : placeholder,
  );
  const listId = useId();
  const nowMs = useNow(60_000);
  const state = useSearch(text, locale, attempt, fetch ? { fetch } : {});
  const waiting = useRetryWait(state.status === "error" ? state.retryAt : undefined);
  const results = state.status === "ready" ? state.results : NO_RESULTS;
  const groups = useMemo(() => groupResults(results), [results]);
  const order = useMemo(() => flatOrder(groups), [groups]);
  const textOf = useResultText(nowMs);
  useSlashShortcut(input);

  const active = hovered < order.length ? hovered : -1;
  const expanded = open && state.status !== "idle";
  const query = searchQueryOf(text);
  const current = state.status === "ready" && state.query === query;
  const [pendingEnter, setPendingEnter] = useState<string | null>(null);

  const choose = (result: SearchResult) => {
    chooseResult(result);
    setText(textOf(result).title);
    setOpen(false);
    setActive(-1);
    if (window.matchMedia?.("(pointer: coarse)").matches) input.current?.blur();
  };

  useEffect(() => {
    if (pendingEnter === null) return;
    if (pendingEnter !== query || state.status === "idle") {
      setPendingEnter(null);
    } else if (state.status !== "loading" && state.query === pendingEnter) {
      setPendingEnter(null);
      const first = order[0];
      if (state.status === "ready" && first !== undefined) choose(first);
    }
  });

  useEffect(() => {
    if (expanded && active >= 0) {
      document.getElementById(`${listId}-option-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, active, listId]);

  const onEscape = () => {
    if (expanded) setOpen(false);
    else if (text !== "") setText("");
    else input.current?.blur();
  };

  const onEnter = () => {
    if (state.status === "error") {
      if (!waiting) setAttempt((count) => count + 1);
    } else if (query === null) return;
    else if (!current) setPendingEnter(query);
    else if (order.length > 0) choose(order[Math.max(active, 0)] as SearchResult);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { key } = event;
    if ((key === "ArrowDown" || key === "ArrowUp") && order.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => nextActive(key, index < order.length ? index : -1, order.length));
    } else if (key === "Enter" && expanded && (state.status === "error" || query !== null)) {
      event.preventDefault();
      onEnter();
    } else if (key === "Escape") {
      event.preventDefault();
      onEscape();
    }
  };

  return (
    <search aria-label={copy.search.label} className={className}>
      <div className="flex items-center gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            type="search"
            role="combobox"
            aria-label={copy.search.label}
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              expanded && active >= 0 ? `${listId}-option-${active}` : undefined
            }
            aria-keyshortcuts="/"
            enterKeyHint="search"
            placeholder={shownPlaceholder}
            value={text}
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setActive(-1);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            className="pl-10 text-ellipsis [&::-webkit-search-cancel-button]:hidden"
          />
          {text ? (
            <ClearButton
              onClear={() => {
                setText("");
                input.current?.focus();
              }}
            />
          ) : null}
        </InputGroup>
        {endSlot}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keeps the focus on the field while a result is pressed */}
      <div
        className={cn(
          "-mx-4 mt-2 max-h-[min(55vh,480px)] overflow-y-auto overscroll-contain border-y border-hairline py-1",
          !expanded && "hidden",
        )}
        data-slot="search-results"
        onMouseDown={(event) => event.preventDefault()}
      >
        <div role="status" aria-live="polite">
          {expanded && current && order.length > 0 ? (
            <span className="sr-only">{a11y.results(order.length)}</span>
          ) : null}
          {expanded ? (
            <StatusLine
              state={state}
              hasResults={results.length > 0}
              waiting={waiting}
              onRetry={() => setAttempt((count) => count + 1)}
            />
          ) : null}
        </div>
        <ResultList
          listId={listId}
          groups={groups}
          active={active}
          textOf={textOf}
          onChoose={choose}
          onHover={setActive}
          stale={state.status === "ready" && !current}
        />
      </div>
    </search>
  );
}
