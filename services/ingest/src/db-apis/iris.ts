import { irisTimeToIso } from "./berlin-time.ts";
import { childrenNamed, firstChild, parseXml, type XmlElement } from "./xml.ts";

export interface IrisTripLabel {
  readonly category: string | null;
  readonly number: string | null;
  readonly owner: string | null;
  readonly filter: string | null;
  readonly tripType: string | null;
}

export interface IrisMessage {
  readonly id: string;
  readonly type: string | null;
  readonly code: number | null;
  readonly category: string | null;
  readonly priority: number | null;
  readonly timestamp: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly deleted: boolean;
}

export type IrisEventStatus = "planned" | "added" | "cancelled";

export interface IrisEvent {
  readonly plannedTime: string | null;
  readonly changedTime: string | null;
  readonly delayMinutes: number | null;
  readonly plannedPlatform: string | null;
  readonly changedPlatform: string | null;
  readonly plannedPath: readonly string[] | null;
  readonly changedPath: readonly string[] | null;
  readonly plannedStatus: IrisEventStatus | null;
  readonly changedStatus: IrisEventStatus | null;
  readonly cancellationTime: string | null;
  readonly line: string | null;
  readonly displayName: string | null;
  readonly hidden: boolean;
  readonly wings: readonly string[];
  readonly transition: string | null;
  readonly distantEndpointChanged: string | null;
  readonly distantChange: string | null;
  readonly messages: readonly IrisMessage[];
}

export interface IrisReferenceTrip {
  readonly id: string | null;
  readonly cancelled: boolean;
  readonly tripLabel: IrisTripLabel | null;
}

export interface IrisStop {
  readonly id: string;
  readonly eva: number | null;
  readonly tripLabel: IrisTripLabel | null;
  readonly arrival: IrisEvent | null;
  readonly departure: IrisEvent | null;
  readonly messages: readonly IrisMessage[];
  readonly references: readonly IrisReferenceTrip[];
}

export interface IrisTimetable {
  readonly station: string | null;
  readonly eva: number | null;
  readonly stops: readonly IrisStop[];
}

export class IrisParseError extends Error {}

const STATUS: Readonly<Record<string, IrisEventStatus>> = {
  p: "planned",
  a: "added",
  c: "cancelled",
};

function text(attributes: Readonly<Record<string, string>>, name: string): string | null {
  const value = attributes[name];
  return value === undefined || value === "" ? null : value;
}

function integer(value: string | null): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

/** A path attribute: absent is null, present but empty is an empty path (a cancelled run keeps no stops). */
function path(attributes: Readonly<Record<string, string>>, name: string): string[] | null {
  const value = attributes[name];
  if (value === undefined) return null;
  return value === "" ? [] : value.split("|");
}

function status(value: string | null): IrisEventStatus | null {
  if (value === null) return null;
  const known = STATUS[value];
  if (!known) throw new IrisParseError(`unknown event status ${value}`);
  return known;
}

function time(
  attributes: Readonly<Record<string, string>>,
  name: string,
  at: number | null,
): string | null {
  const raw = text(attributes, name);
  if (raw === null) return null;
  const iso = irisTimeToIso(raw, at);
  if (iso === null) throw new IrisParseError(`malformed time ${name}="${raw}"`);
  return iso;
}

function tripLabel(element: XmlElement | undefined): IrisTripLabel | null {
  if (!element) return null;
  const a = element.attributes;
  return {
    category: text(a, "c"),
    number: text(a, "n"),
    owner: text(a, "o"),
    filter: text(a, "f"),
    tripType: text(a, "t"),
  };
}

function message(element: XmlElement, at: number | null): IrisMessage {
  const a = element.attributes;
  const id = text(a, "id");
  if (id === null) throw new IrisParseError("message without id");
  return {
    id,
    type: text(a, "t"),
    code: integer(text(a, "c")),
    category: text(a, "cat"),
    priority: integer(text(a, "pr")),
    timestamp: time(a, "ts", at),
    validFrom: time(a, "from", at),
    validTo: time(a, "to", at),
    deleted: text(a, "del") === "1",
  };
}

function minutesBetween(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null;
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

function event(element: XmlElement | undefined, at: number | null): IrisEvent | null {
  if (!element) return null;
  const a = element.attributes;
  const plannedTime = time(a, "pt", at);
  const changedTime = time(a, "ct", at);
  return {
    plannedTime,
    changedTime,
    delayMinutes: minutesBetween(plannedTime, changedTime),
    plannedPlatform: text(a, "pp"),
    changedPlatform: text(a, "cp"),
    plannedPath: path(a, "ppth"),
    changedPath: path(a, "cpth"),
    plannedStatus: status(text(a, "ps")),
    changedStatus: status(text(a, "cs")),
    cancellationTime: time(a, "clt", at),
    line: text(a, "l"),
    displayName: text(a, "fb"),
    hidden: text(a, "hi") === "1",
    wings: text(a, "wings")?.split("|") ?? [],
    transition: text(a, "tra"),
    distantEndpointChanged: text(a, "cde"),
    distantChange: text(a, "dc"),
    messages: childrenNamed(element, "m").map((item) => message(item, at)),
  };
}

function reference(element: XmlElement): IrisReferenceTrip[] {
  const label = tripLabel(firstChild(element, "tl"));
  const trips = childrenNamed(element, "rt");
  if (trips.length === 0) return [{ id: null, cancelled: false, tripLabel: label }];
  return trips.map((trip) => ({
    id: text(trip.attributes, "id"),
    cancelled: text(trip.attributes, "c") === "true",
    tripLabel: label,
  }));
}

function stop(element: XmlElement, fallbackEva: number | null, at: number | null): IrisStop {
  const id = text(element.attributes, "id");
  if (id === null) throw new IrisParseError("stop without id");
  return {
    id,
    eva: integer(text(element.attributes, "eva")) ?? fallbackEva,
    tripLabel: tripLabel(firstChild(element, "tl")),
    arrival: event(firstChild(element, "ar"), at),
    departure: event(firstChild(element, "dp"), at),
    messages: childrenNamed(element, "m").map((item) => message(item, at)),
    references: childrenNamed(element, "ref").flatMap(reference),
  };
}

/**
 * One DB Timetables answer (`plan`, `fchg` or `rchg`) as typed records. Times are German local time in
 * the payload and UTC ISO strings here. Throws `IrisParseError` or `XmlError` for a payload it cannot
 * read, never returns a partial result. A `plan` answer names no EVA number; `requestedEva` fills it.
 * `askedAt` (epoch ms, the request's time) settles times in the repeated hour of the autumn switch.
 */
export function parseIrisTimetable(
  payload: string | Buffer,
  requestedEva: number | null = null,
  askedAt: number | null = null,
): IrisTimetable {
  const root = parseXml(typeof payload === "string" ? payload : payload.toString("utf8"));
  if (root.name !== "timetable")
    throw new IrisParseError(`root is <${root.name}>, not <timetable>`);
  const eva = integer(text(root.attributes, "eva")) ?? requestedEva;
  return {
    station: text(root.attributes, "station"),
    eva,
    stops: childrenNamed(root, "s").map((element) => stop(element, eva, askedAt)),
  };
}

/** True when an event carries a realtime change: time, platform, path, status or a cancellation. */
export function eventChanged(event: IrisEvent | null): boolean {
  if (!event) return false;
  return (
    event.changedTime !== null ||
    event.changedPlatform !== null ||
    event.changedPath !== null ||
    event.changedStatus !== null ||
    event.cancellationTime !== null
  );
}

export function stopChanged(stop: IrisStop): boolean {
  return eventChanged(stop.arrival) || eventChanged(stop.departure);
}
