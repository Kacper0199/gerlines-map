import { usePlaybackCopy } from "@gerlines/i18n/playback";
import { useFormatters } from "@gerlines/i18n/react";
import { Button, cn, FIELD_BASE, IconButton } from "@gerlines/ui";
import { Pause, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaybackState } from "../live/playback/driver.ts";
import { PLAYBACK_PANEL_ID } from "./HistoryControl.tsx";
import { type DayGroup, dayGroups, dayOf, hourLabel, newestAvailable } from "./hours.ts";
import { SPEEDS, usePlaybackStore } from "./store.ts";
import { useClockWithSeconds } from "./use-clock.ts";

const HISTORY_BUTTON = '[data-slot="history-button"]';
const PRESSED =
  "aria-pressed:bg-raised aria-pressed:text-ink aria-pressed:shadow-[inset_0_0_0_2px_var(--gl-ink)]";
const SEEK_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

function Pickers({
  groups,
  selected,
  onPick,
  disabled,
}: {
  groups: readonly DayGroup[];
  selected: number | undefined;
  onPick: (start: number) => void;
  disabled?: boolean;
}) {
  const copy = usePlaybackCopy();
  const format = useFormatters();
  const day = selected === undefined ? undefined : dayOf(groups, selected);
  const dayId = "playback-day";
  const hourId = "playback-hour";
  const firstAvailable = (group: DayGroup) => group.hours.find((hour) => hour.available)?.start;
  return (
    <div className="flex gap-2">
      <label htmlFor={dayId} className="flex min-w-0 flex-3 flex-col gap-1">
        <span className="type-caption text-ink-muted">{copy.day}</span>
        <select
          id={dayId}
          className={FIELD_BASE}
          value={day?.key ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const group = groups.find((entry) => entry.key === event.target.value);
            const start = group ? firstAvailable(group) : undefined;
            if (start !== undefined) onPick(start);
          }}
        >
          {groups.map((group) => (
            <option key={group.key} value={group.key}>
              {format.day(group.firstStart * 1000)}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={hourId} className="flex min-w-0 flex-2 flex-col gap-1">
        <span className="type-caption text-ink-muted">{copy.hour}</span>
        <select
          id={hourId}
          className={FIELD_BASE}
          value={selected ?? ""}
          disabled={disabled}
          onChange={(event) => onPick(Number(event.target.value))}
        >
          {(day?.hours ?? []).map((hour) => (
            <option key={hour.start} value={hour.start} disabled={!hour.available}>
              {hour.available ? hourLabel(hour) : `${hourLabel(hour)} ${copy.hourMissing}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Scrubber({ state }: { state: PlaybackState }) {
  const copy = usePlaybackCopy();
  const clock = useClockWithSeconds();
  const seek = usePlaybackStore((store) => store.seek);
  const [drag, setDrag] = useState<number | null>(null);
  const start = state.windowStart;
  const end = state.windowEnd;
  if (start === null || end === null) return null;
  const value = Math.min(Math.max(drag ?? state.position, start), end);
  const commit = () => {
    if (drag === null) return;
    seek(drag);
    setDrag(null);
  };
  const steady = drag === null && state.playing && state.phase === "playing";
  const spoken = steady ? clock(value).slice(0, 5) : clock(value);
  return (
    <div className="flex flex-col gap-1">
      <input
        type="range"
        min={start}
        max={end}
        step={1}
        value={value}
        aria-label={copy.scrubber}
        aria-valuetext={spoken}
        className="focus-ring h-6 w-full cursor-pointer accent-ink"
        onChange={(event) => setDrag(Number(event.target.value))}
        onPointerUp={commit}
        onPointerCancel={() => setDrag(null)}
        onBlur={commit}
        onKeyUp={(event) => {
          if (SEEK_KEYS.has(event.key)) commit();
        }}
      />
      <div className="type-data-small flex justify-between text-ink-muted" aria-hidden="true">
        <span>{clock(start).slice(0, 5)}</span>
        <span>{clock(end).slice(0, 5)}</span>
      </div>
    </div>
  );
}

function Transport({ state, groups }: { state: PlaybackState; groups: readonly DayGroup[] }) {
  const copy = usePlaybackCopy();
  const format = useFormatters();
  const clock = useClockWithSeconds();
  const play = usePlaybackStore((store) => store.play);
  const pause = usePlaybackStore((store) => store.pause);
  const setSpeed = usePlaybackStore((store) => store.setSpeed);
  const seek = usePlaybackStore((store) => store.seek);
  const shownPlaying = state.playing && state.phase !== "ended";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconButton
          label={shownPlaying ? copy.pause : copy.play}
          variant="solid"
          data-slot="play-pause"
          disabled={state.phase === "ended" || state.error !== null}
          onClick={shownPlaying ? pause : play}
        >
          {shownPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </IconButton>
        <div className="flex min-w-0 flex-col" role="timer" aria-label={copy.time}>
          <span className="type-data tabular-nums" data-slot="playback-clock">
            {clock(state.position)}
          </span>
          <span className="type-caption text-ink-muted">{format.day(state.position * 1000)}</span>
        </div>
        <fieldset className="ml-auto flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
          <legend className="sr-only">{copy.speed}</legend>
          {SPEEDS.map((speed) => (
            <Button
              key={speed}
              variant="quiet"
              aria-pressed={state.speed === speed}
              className={cn("h-target min-w-target px-2", PRESSED)}
              onClick={() => setSpeed(speed)}
            >
              {`${speed}x`}
            </Button>
          ))}
        </fieldset>
      </div>
      <Scrubber key={state.windowStart} state={state} />
      <Pickers
        groups={groups}
        selected={state.windowStart ?? undefined}
        onPick={(start) => seek(start)}
      />
    </>
  );
}

function Message({ state }: { state: PlaybackState | null }) {
  const copy = usePlaybackCopy();
  const code = state?.error ?? state?.notice ?? null;
  let progress: string | null = null;
  if (code === null && state?.phase === "ended") progress = copy.ended;
  else if (code === null && (state?.phase === "seeking" || state?.phase === "opening")) {
    progress = copy.seeking;
  }
  return (
    <>
      <div role="status" aria-live="polite">
        {progress === null ? null : <p className="type-caption text-ink-muted">{progress}</p>}
      </div>
      <div role="alert">
        {code === null ? null : (
          <p className="type-caption flex items-start gap-2 text-ink">
            <span
              aria-hidden="true"
              className="mt-1 size-2 shrink-0 rounded-full shadow-[inset_0_0_0_2px_var(--gl-error)]"
            />
            {copy.errors[code]}
          </p>
        )}
      </div>
    </>
  );
}

function PickerView({ groups }: { groups: readonly DayGroup[] }) {
  const copy = usePlaybackCopy();
  const start = usePlaybackStore((store) => store.start);
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const selected = picked ?? newestAvailable(groups);
  return (
    <>
      <p className="type-caption text-ink-muted">{copy.hint}</p>
      <Pickers groups={groups} selected={selected} onPick={setPicked} />
      <Button
        variant="solid"
        data-slot="playback-start"
        disabled={selected === undefined}
        onClick={() => selected !== undefined && start(selected)}
      >
        <Play aria-hidden="true" />
        {copy.start}
      </Button>
    </>
  );
}

function Body({ state }: { state: PlaybackState | null }) {
  const copy = usePlaybackCopy();
  const status = usePlaybackStore((store) => store.listStatus);
  const list = usePlaybackStore((store) => store.list);
  const loadList = usePlaybackStore((store) => store.loadList);
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const groups = useMemo(() => (list ? dayGroups(list, now) : []), [list, now]);
  if (status === "error" && list === null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="type-body">
          {copy.listError}
        </p>
        <Button variant="secondary" onClick={() => void loadList()}>
          {copy.retry}
        </Button>
      </div>
    );
  }
  if (list === null) return <p className="type-caption text-ink-muted">{copy.loading}</p>;
  const picking = state === null || (state.windowStart === null && state.error !== null);
  if (groups.length === 0 && picking) {
    return <p className="type-body text-ink-muted">{copy.empty}</p>;
  }
  return picking ? <PickerView groups={groups} /> : <Transport state={state} groups={groups} />;
}

/** The timeline: pick a past hour, then play, pause, change the speed and move within it. */
export default function PlaybackPanel() {
  const copy = usePlaybackCopy();
  const state = usePlaybackStore((store) => store.state);
  const closePanel = usePlaybackStore((store) => store.closePanel);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement?.matches(HISTORY_BUTTON))
      heading.current?.focus({ preventScroll: true });
  }, []);
  const close = () => {
    closePanel();
    document.querySelector<HTMLElement>(HISTORY_BUTTON)?.focus();
  };
  return (
    <section
      id={PLAYBACK_PANEL_ID}
      aria-label={copy.title}
      data-slot="playback-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
      className="card-surface card-enter pointer-events-auto flex w-[min(560px,100%)] flex-col gap-3 p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} className="type-label outline-none">
          {copy.title}
        </h2>
        <IconButton label={copy.close} onClick={close}>
          <X aria-hidden="true" />
        </IconButton>
      </header>
      <Body state={state} />
      <Message state={state} />
    </section>
  );
}
