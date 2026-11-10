import type { Position, StopRow, TrainCardModel } from "./model.ts";

export type StripMode = "focus" | "all";
export type Tone = "passed" | "ahead" | "plain" | "none";
export type HeadlineLabel = "next" | "at" | "before" | "arrived";

interface Rails {
  readonly upper: Tone;
  readonly lower: Tone;
}

export type StripItem =
  | { readonly kind: "passed" | "upcoming" | "plain"; readonly stop: StopRow }
  | { readonly kind: "headline"; readonly stop: StopRow; readonly label: HeadlineLabel }
  | { readonly kind: "now"; readonly progress: number; readonly arrivalMs: number };

export type StripRow = StripItem & Rails;

function headlineOf(position: Position): { stop: StopRow; label: HeadlineLabel } | null {
  switch (position.kind) {
    case "between":
      return { stop: position.to, label: "next" };
    case "at":
    case "before":
    case "arrived":
      return { stop: position.stop, label: position.kind };
    default:
      return null;
  }
}

function cancelledBetween(stops: readonly StopRow[], from: StopRow, to: StopRow | null): StopRow[] {
  if (to === null) {
    return [];
  }
  return stops.filter((stop) => stop.cancelled && stop.index > from.index && stop.index < to.index);
}

function focusIndexes(
  position: Position,
  stops: readonly StopRow[],
  compact: boolean,
): Set<number> {
  const pick = (...rows: (StopRow | null | undefined)[]) =>
    new Set(rows.filter((row): row is StopRow => row != null).map((row) => row.index));
  switch (position.kind) {
    case "between":
      return pick(
        compact ? null : position.from,
        ...cancelledBetween(stops, position.from, position.to),
        position.to,
      );
    case "at":
    case "before":
      return compact
        ? pick(position.stop)
        : pick(
            position.stop,
            ...cancelledBetween(stops, position.stop, position.next),
            position.next,
          );
    case "arrived":
      return pick(compact ? null : position.from, position.stop);
    default:
      return pick(stops[0], stops[stops.length - 1]);
  }
}

function itemFor(
  stop: StopRow,
  position: Position,
  headline: ReturnType<typeof headlineOf>,
): StripItem {
  if (position.kind === "cancelled") {
    return { kind: "plain", stop };
  }
  if (headline && stop.index === headline.stop.index) {
    return { kind: "headline", stop, label: headline.label };
  }
  return { kind: stop.role === "passed" ? "passed" : "upcoming", stop };
}

function items(model: TrainCardModel, mode: StripMode, compact: boolean): StripItem[] {
  const { position, stops } = model;
  const headline = headlineOf(position);
  const shown = mode === "all" ? null : focusIndexes(position, stops, compact);
  const visible = stops.filter((stop) => !shown || shown.has(stop.index));
  const list = visible.map((stop) => itemFor(stop, position, headline));
  if (position.kind === "between") {
    const at = visible.findIndex((stop) => stop.index > position.from.index);
    list.splice(at, 0, { kind: "now", progress: position.progress, arrivalMs: position.arrivalMs });
  }
  return list;
}

function leadsAhead(item: StripItem): boolean {
  return item.kind === "upcoming" || (item.kind === "headline" && item.label === "next");
}

function beyondService(item: StripItem | undefined, lastServedIndex: number | null): boolean {
  return (
    lastServedIndex !== null &&
    item !== undefined &&
    item.kind !== "now" &&
    item.stop.index > lastServedIndex
  );
}

function tone(
  above: StripItem | undefined,
  below: StripItem | undefined,
  lastServedIndex: number | null,
): Tone {
  if (!above || !below) {
    return "none";
  }
  if (above.kind === "plain" || below.kind === "plain") {
    return "plain";
  }
  if (beyondService(below, lastServedIndex)) {
    return "passed";
  }
  if (above.kind === "now") {
    return "ahead";
  }
  return leadsAhead(below) ? "ahead" : "passed";
}

export function stripRows(model: TrainCardModel, mode: StripMode, compact: boolean): StripRow[] {
  const list = items(model, mode, compact);
  const last = model.lastServedIndex;
  return list.map((item, i) => ({
    ...item,
    upper: tone(list[i - 1], item, last),
    lower: tone(item, list[i + 1], last),
  }));
}
