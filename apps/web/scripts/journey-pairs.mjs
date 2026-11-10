#!/usr/bin/env node
// Scripted journey pairs for WP-8.2: resolves each station name through /api/v1/search to its DELFI stop id,
// asks /api/v1/journeys (with route lines, as the planner does) and reports share answered, latency and failures.
// The planner path takes the first station hit with a stop id (stopId, or dhid from an older API) whose
// name holds the asked name (station-match.mjs), as a person typing it would accept; any other hit, such as
// Metzingen Bahnhof for Metz, leaves the station not enterable. Such a station falls back to its stop id in the
// enriched DELFI feed of 2026-10-19, so the API is measured on every pair while the planner path is counted apart.
// Each answered row keeps its journeys with their train legs (stops, planned times, train numbers) for the plausibility
// check against DB's plan (journey-plausibility.ts).
// Usage: node scripts/journey-pairs.mjs <base url> <out.json> [service day, default 2026-11-10]. Paced under the 30
// journey requests per minute limit.
import { writeFileSync } from "node:fs";
import { nameHoldsQuery } from "./station-match.mjs";

const [base, out, day] = process.argv.slice(2);
if (!(base && out)) {
  process.stderr.write(
    "usage: node scripts/journey-pairs.mjs <base url> <out.json> [YYYY-MM-DD]\n",
  );
  process.exit(2);
}

const DAY = day ?? "2026-11-10";
const PAIRS = [
  ["hub", "Berlin Hbf", "München Hbf", "07:00"],
  ["hub", "Hamburg Hbf", "Köln Hbf", "08:00"],
  ["hub", "Frankfurt (Main) Hbf", "Berlin Hbf", "09:00"],
  ["hub", "Stuttgart Hbf", "Hamburg Hbf", "06:30"],
  ["hub", "Düsseldorf Hbf", "Leipzig Hbf", "10:00"],
  ["hub", "Hannover Hbf", "Nürnberg Hbf", "12:00"],
  ["hub", "Dresden Hbf", "Frankfurt (Main) Hbf", "07:30"],
  ["hub", "Köln Hbf", "München Hbf", "14:00"],
  ["hub", "Bremen Hbf", "Mannheim Hbf", "11:00"],
  ["hub", "Dortmund Hbf", "Berlin Hbf", "16:00"],
  ["hub", "Kiel Hbf", "Karlsruhe Hbf", "06:00"],
  ["hub", "Rostock Hbf", "Stuttgart Hbf", "08:30"],
  ["hub", "Erfurt Hbf", "Hamburg Hbf", "17:00"],
  ["hub", "Saarbrücken Hbf", "Berlin Hbf", "07:00"],
  ["hub", "Freiburg (Breisgau) Hbf", "Kassel-Wilhelmshöhe", "09:30"],
  ["regional", "Bremen Hbf", "Oldenburg (Oldb) Hbf", "07:15"],
  ["regional", "Augsburg Hbf", "Ulm Hbf", "08:10"],
  ["regional", "Göttingen", "Kassel Hbf", "13:00"],
  ["regional", "Tübingen Hbf", "Stuttgart Hbf", "06:45"],
  ["regional", "Lüneburg", "Uelzen", "10:20"],
  ["regional", "Gießen", "Marburg (Lahn)", "15:00"],
  ["regional", "Cottbus Hbf", "Görlitz", "09:00"],
  ["regional", "Rosenheim", "Kufstein", "11:30"],
  ["regional", "Siegen Hbf", "Hagen Hbf", "07:40"],
  ["regional", "Trier Hbf", "Koblenz Hbf", "12:30"],
  ["regional", "Schwerin Hbf", "Wismar", "08:00"],
  ["regional", "Magdeburg Hbf", "Halle (Saale) Hbf", "17:30"],
  ["regional", "Würzburg Hbf", "Bamberg", "10:00"],
  ["regional", "Konstanz", "Singen (Hohentwiel)", "14:15"],
  ["regional", "Husum", "Westerland (Sylt)", "09:10"],
  ["regional", "Bad Harzburg", "Hannover Hbf", "06:20"],
  ["regional", "Passau Hbf", "Regensburg Hbf", "18:00"],
  ["regional", "Flensburg", "Neumünster", "07:50"],
  ["cross-border", "Aachen Hbf", "Liège-Guillemins", "08:00"],
  ["cross-border", "Köln Hbf", "Amsterdam Centraal", "09:00"],
  ["cross-border", "Freiburg (Breisgau) Hbf", "Basel SBB", "10:00"],
  ["cross-border", "München Hbf", "Salzburg Hbf", "11:00"],
  ["cross-border", "Frankfurt (Main) Hbf", "Paris Est", "12:00"],
  ["cross-border", "Berlin Hbf", "Szczecin Główny", "07:30"],
  ["cross-border", "Dresden Hbf", "Praha hl.n.", "08:00"],
  ["cross-border", "Hamburg Hbf", "Kobenhavn H", "07:00"],
  ["cross-border", "Saarbrücken Hbf", "Metz", "13:00"],
  ["cross-border", "Lindau-Reutin", "Bregenz", "15:00"],
  ["cross-border", "Görlitz", "Wrocław Główny", "09:00"],
  ["night", "Hamburg Hbf", "München Hbf", "21:30"],
  ["night", "Berlin Hbf", "Köln Hbf", "23:00"],
  ["night", "München Hbf", "Wien Hbf", "22:30"],
  ["night", "Frankfurt (Main) Hbf", "Hamburg Hbf", "23:45"],
  ["night", "Stuttgart Hbf", "Berlin Hbf", "00:30"],
  ["night", "Köln Hbf", "Leipzig Hbf", "01:00"],
];

const FEED_STOPS = {
  "Stuttgart Hbf": "de:08111:6115:1:1",
  "Freiburg (Breisgau) Hbf": "de:08311:6508",
  "Kassel-Wilhelmshöhe": "de:06611:200007:0:E",
  "Marburg (Lahn)": "de:06534:10011",
  Kufstein: "at:47:2184",
  "Singen (Hohentwiel)": "de:08335:6588",
  "Liège-Guillemins": "be:62000:7500",
  "Amsterdam Centraal": "000008400058",
  "Basel SBB": "ch:1:sloid:10",
  "Salzburg Hbf": "at:45:50002",
  "Paris Est": "000008700011",
  "Szczecin Główny": "pl:unknown:EVANR-5100057",
  "Praha hl.n.": "000005400014",
  Bregenz: "at:48:452",
  "Lindau-Reutin": "de:09776:1592",
  "Wrocław Główny": "pl:unknown:EVANR-5100069",
  "Wien Hbf": "at:49:1349",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stationCache = new Map();

async function station(name) {
  if (stationCache.has(name)) return stationCache.get(name);
  const response = await fetch(
    `${base}/api/v1/search?${new URLSearchParams({ q: name, lang: "en" })}`,
  );
  const body = await response.json();
  const found = (body.results ?? []).find(
    (result) =>
      result.kind === "station" &&
      (result.stopId ?? result.dhid) &&
      nameHoldsQuery(result.name, name),
  );
  const feed = FEED_STOPS[name];
  const value = found
    ? { name: found.name, stopId: found.stopId ?? found.dhid, via: "search" }
    : feed
      ? { name, stopId: feed, via: "feed" }
      : null;
  stationCache.set(name, value);
  return value;
}

function stopOf(stop) {
  return {
    stopId: stop.stopId,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    scheduledTime: stop.scheduledTime,
  };
}

function journeyOf(journey) {
  return {
    departure: journey.departure,
    arrival: journey.arrival,
    durationS: journey.durationS,
    transfers: journey.transfers,
    legs: journey.legs
      .filter((leg) => leg.kind === "transit")
      .map((leg) => ({
        category: leg.category,
        line: leg.line,
        tripNumber: leg.tripNumber,
        operator: leg.operator,
        scheduledDeparture: leg.scheduledDeparture,
        scheduledArrival: leg.scheduledArrival,
        from: stopOf(leg.from),
        to: stopOf(leg.to),
      })),
  };
}

function instant(local) {
  return `${DAY}T${local}:00+01:00`;
}

const rows = [];
for (const [kind, fromName, toName, time] of PAIRS) {
  const [from, to] = [await station(fromName), await station(toName)];
  const row = { kind, from: fromName, to: toName, time };
  if (!(from && to)) {
    rows.push({ ...row, outcome: "station_not_found", missing: !from ? fromName : toName });
    continue;
  }
  row.via = from.via === "search" && to.via === "search" ? "search" : "feed";
  row.fromStop = `${from.name} ${from.stopId}`;
  row.toStop = `${to.name} ${to.stopId}`;
  row.askedTime = instant(time);
  const params = new URLSearchParams({
    from: from.stopId,
    to: to.stopId,
    time: instant(time),
    results: "5",
    geometry: "true",
  });
  const started = performance.now();
  const response = await fetch(`${base}/api/v1/journeys?${params}`);
  const text = await response.text();
  row.ms = Math.round(performance.now() - started);
  row.status = response.status;
  row.bytes = text.length;
  if (response.status === 200) {
    const body = JSON.parse(text);
    const legs = body.journeys.flatMap((journey) =>
      journey.legs.filter((leg) => leg.kind === "transit"),
    );
    row.journeys = body.journeys.length;
    row.outcome = body.journeys.length > 0 ? "answered" : "empty";
    row.legsWithLine = legs.filter((leg) => leg.geometry).length;
    row.legs = legs.length;
    row.firstDeparture = body.journeys[0]?.departure ?? null;
    row.journeyLegs = body.journeys.map(journeyOf);
    row.minDurationMin = body.journeys.length
      ? Math.round(Math.min(...body.journeys.map((journey) => journey.durationS)) / 60)
      : null;
  } else {
    row.outcome = "error";
    row.error = text.slice(0, 200);
  }
  rows.push(row);
  process.stdout.write(
    `${row.outcome.padEnd(17)} ${String(row.ms ?? "").padStart(6)} ms  ${kind} ${fromName} -> ${toName}\n`,
  );
  await sleep(2_200);
}

const timed = rows
  .filter((row) => typeof row.ms === "number")
  .map((row) => row.ms)
  .sort((a, b) => a - b);
const pick = (q) => timed[Math.min(timed.length - 1, Math.floor(q * timed.length))];
const answered = rows.filter((row) => row.outcome === "answered").length;
const summary = {
  day: DAY,
  pairs: rows.length,
  answered,
  shareAnswered: answered / rows.length,
  medianMs: pick(0.5),
  p95Ms: pick(0.95),
  maxMs: timed.at(-1),
  byKind: Object.fromEntries(
    ["hub", "regional", "cross-border", "night"].map((kind) => {
      const of = rows.filter((row) => row.kind === kind);
      return [
        kind,
        { pairs: of.length, answered: of.filter((row) => row.outcome === "answered").length },
      ];
    }),
  ),
  plannerPath: {
    pairs: rows.filter((row) => row.via === "search").length,
    answered: rows.filter((row) => row.via === "search" && row.outcome === "answered").length,
  },
  legs: rows.reduce((sum, row) => sum + (row.legs ?? 0), 0),
  legsWithLine: rows.reduce((sum, row) => sum + (row.legsWithLine ?? 0), 0),
};
writeFileSync(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
