import type { StatusCopy } from "@gerlines/i18n/status";
import type {
  DataSourceKind,
  DataSourceState,
  DataSourceStatus,
  DataStatus,
} from "@gerlines/schema/status";

export interface TimeFormat {
  readonly clock: (ms: number) => string;
  readonly day: (ms: number) => string;
}

/** A line of the popover and the time or number in it, which the panel sets in Overpass Mono. */
export interface Phrase {
  readonly text: string;
  readonly figure: string | null;
}

/** The clocks the live line is measured against, all on this device's clock. */
export interface LiveTiming {
  readonly now: number;
  /** When the answer was read on the server: its arrival less the age the caches gave it. */
  readonly answeredAt: number;
  /** When this map's own newest live frame arrived (the live worker); undefined without one. */
  readonly mapFrameAt?: number | undefined;
}

export interface StatusRow {
  readonly id: string;
  readonly name: string;
  /** The country of a neighbour's feed; null for the German ones, which their group already says. */
  readonly area: string | null;
  readonly state: DataSourceState;
  readonly stateLabel: string;
  readonly recorded: Phrase | null;
  readonly onMap: Phrase | null;
}

export interface StatusGroup {
  readonly kind: DataSourceKind;
  readonly title: string;
  readonly rows: readonly StatusRow[];
}

export interface LiveLine {
  readonly state: DataSourceState;
  readonly stateLabel: string;
  readonly detail: Phrase;
}

export interface StatusView {
  readonly asOf: Phrase;
  readonly live: LiveLine;
  readonly groups: readonly StatusGroup[];
  readonly note: string | null;
}

const KIND_ORDER: readonly DataSourceKind[] = ["timetable", "realtime", "iris", "neighbours"];

/** The live line counts seconds up to two minutes, then names the time of the last update. */
const SECONDS_SHOWN_UP_TO = 120;

/** A time of day, with the day in front when it is not the day of `reference` (Berlin). */
export function timeLabel(ms: number, reference: number, format: TimeFormat): string {
  const clock = format.clock(ms);
  return format.day(ms) === format.day(reference) ? clock : `${format.day(ms)} ${clock}`;
}

function phrase(text: string, figure: string | null = null): Phrase {
  return { text, figure: figure !== null && text.includes(figure) ? figure : null };
}

function timed(make: (time: string) => string, ms: number, reference: number, format: TimeFormat) {
  return phrase(make(timeLabel(ms, reference, format)), format.clock(ms));
}

/**
 * The map time of a feed is known only while the live engine's details give a reading; without
 * one the row leaves it out instead of saying the feed is not on the map.
 */
function rowOf(
  source: DataSourceStatus,
  status: DataStatus,
  copy: StatusCopy,
  format: TimeFormat,
): StatusRow {
  const at = Date.parse(status.at);
  const recordedAt = source.recordedAt === null ? null : Date.parse(source.recordedAt);
  const dataTime = source.dataTime === null ? null : Date.parse(source.dataTime);
  const mapRead = status.live.confirmedAt !== null;
  return {
    id: source.id,
    name: source.name,
    area: source.kind === "neighbours" ? (copy.country[source.country] ?? source.country) : null,
    state: source.state,
    stateLabel: copy.state[source.state],
    recorded: recordedAt === null ? null : timed(copy.recorded, recordedAt, at, format),
    onMap:
      source.kind === "timetable" || !mapRead
        ? null
        : dataTime === null
          ? phrase(copy.notOnMap)
          : timed(copy.onMap, dataTime, at, format),
  };
}

function ageLine(
  ageS: number,
  lastAt: number,
  reference: number,
  copy: StatusCopy,
  format: TimeFormat,
): Phrase {
  if (ageS <= SECONDS_SHOWN_UP_TO) return phrase(copy.live.age(ageS), String(ageS));
  return timed(copy.live.since, lastAt, reference, format);
}

/**
 * This map's own newest frame when it has one, so the line holds without the engine's detail
 * writer and is as old as the frame now; else the server's reading, aged by the time since it.
 */
function liveLine(
  status: DataStatus,
  copy: StatusCopy,
  format: TimeFormat,
  timing: LiveTiming,
): LiveLine {
  const { live } = status;
  const limitS = live.staleAfterSeconds;
  const { now, mapFrameAt } = timing;
  if (mapFrameAt !== undefined) {
    const ageS = Math.max(0, Math.round((now - mapFrameAt) / 1000));
    const state: DataSourceState = ageS > limitS ? "stale" : "ok";
    return {
      state,
      stateLabel: copy.state[state],
      detail: ageLine(ageS, mapFrameAt, now, copy, format),
    };
  }
  if (live.confirmedAt === null || live.frameAgeSeconds === null) {
    return {
      state: live.state,
      stateLabel: copy.state[live.state],
      detail: phrase(live.state === "not_recorded" ? copy.live.noReading : copy.live.none),
    };
  }
  const sinceAnswerS = Math.max(0, Math.round((now - timing.answeredAt) / 1000));
  const ageS = live.frameAgeSeconds + sinceAnswerS;
  const state: DataSourceState = live.state === "ok" && ageS > limitS ? "stale" : live.state;
  return {
    state,
    stateLabel: copy.state[state],
    detail: ageLine(ageS, Date.parse(live.confirmedAt), Date.parse(status.at), copy, format),
  };
}

function noteOf(status: DataStatus, copy: StatusCopy): string | null {
  const minutes = status.sources
    .map((source) => source.staleAfterSeconds)
    .filter((seconds): seconds is number => seconds !== null)
    .map((seconds) => Math.round(seconds / 60));
  if (minutes.length === 0) return null;
  return copy.note(Math.min(...minutes), Math.max(...minutes));
}

/** The popover's content: the live map line, then each kind of source in a fixed order. */
export function statusView(
  status: DataStatus,
  copy: StatusCopy,
  format: TimeFormat,
  timing: LiveTiming,
): StatusView {
  const at = Date.parse(status.at);
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    title: copy.kind[kind],
    rows: status.sources
      .filter((source) => source.kind === kind)
      .map((source) => rowOf(source, status, copy, format)),
  })).filter((group) => group.rows.length > 0);
  const clock = format.clock(at);
  return {
    asOf: phrase(copy.asOf(clock), clock),
    live: liveLine(status, copy, format, timing),
    groups,
    note: noteOf(status, copy),
  };
}
