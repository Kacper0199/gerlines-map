import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { summaryOf } from "./summary.js";

const API = __ENV.API_ORIGIN || "http://host.docker.internal:8815";
const DURATION_S = Number(__ENV.DURATION_S || 60);
const IDS = JSON.parse(open(__ENV.IDS_FILE || "/out/ids.json"));
const SEARCH_TERMS = [
  "Berlin",
  "Berlin Hbf",
  "München",
  "Mün",
  "Hamburg",
  "Köln",
  "Frankfurt",
  "Leipzig",
  "Dresden Hbf",
  "Stuttgart",
  "Hannover",
  "Nürnberg",
  "ICE 693",
  "RE6",
  "S1",
  "RB26",
  "Potsdam",
  "Erfurt",
  "Mainz",
  "Freiburg",
];

const RATES = {
  trains: Number(__ENV.RATE_TRAINS || 20),
  keys: Number(__ENV.RATE_KEYS || 20),
  search: Number(__ENV.RATE_SEARCH || 10),
  stations: Number(__ENV.RATE_STATIONS || 5),
  status: Number(__ENV.RATE_STATUS || 5),
};

const durations = Object.fromEntries(
  Object.keys(RATES).map((route) => [route, new Trend(`api_${route}_ms`, true)]),
);
const OUTCOMES = ["ok", "notFound", "limited", "otherClient", "server", "failed"];
const outcomes = Object.fromEntries(
  Object.keys(RATES).map((route) => [
    route,
    Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, new Counter(`api_${route}_${outcome}`)]),
    ),
  ]),
);

function outcomeOf(status) {
  if (status === 0) return "failed";
  if (status < 400) return "ok";
  if (status === 404) return "notFound";
  if (status === 429) return "limited";
  if (status < 500) return "otherClient";
  return "server";
}

function scenario(route) {
  return {
    executor: "constant-arrival-rate",
    rate: RATES[route],
    timeUnit: "1s",
    duration: `${DURATION_S}s`,
    preAllocatedVUs: Math.max(4, RATES[route] * 2),
    maxVUs: Math.max(20, RATES[route] * 10),
    exec: route,
    tags: { route },
  };
}

export const options = {
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  setupTimeout: "120s",
  scenarios: Object.fromEntries(
    Object.keys(RATES)
      .filter((route) => RATES[route] > 0)
      .map((route) => [route, scenario(route)]),
  ),
};

function clientAddress() {
  const n = Math.floor(Math.random() * 16_000_000);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function get(route, path) {
  const response = http.get(`${API}${path}`, {
    headers: { "X-Forwarded-For": clientAddress(), "Accept-Encoding": "br, gzip" },
    tags: { route, name: route },
  });
  durations[route].add(response.timings.duration);
  outcomes[route][outcomeOf(response.status)].add(1);
  return response;
}

export function setup() {
  const stations = new Set();
  for (const term of SEARCH_TERMS.slice(0, 12)) {
    const response = http.get(`${API}/api/v1/search?q=${encodeURIComponent(term)}&limit=10`, {
      headers: { "X-Forwarded-For": clientAddress() },
    });
    if (response.status !== 200) continue;
    for (const result of response.json("results") || []) {
      if (result.kind === "station" && result.id) stations.add(result.id);
    }
  }
  return { stations: [...stations] };
}

export function trains() {
  get("trains", `/api/v1/trains/${pick(IDS.trains)}`);
}

export function keys() {
  get("keys", `/api/v1/live/keys/${pick(IDS.keys)}`);
}

export function search() {
  get("search", `/api/v1/search?q=${encodeURIComponent(pick(SEARCH_TERMS))}`);
}

export function stations(data) {
  get("stations", `/api/v1/stations/${encodeURIComponent(pick(data.stations))}`);
}

export function status() {
  get("status", "/api/v1/status");
}

export function handleSummary(data) {
  return summaryOf(data, "api", {
    durationSeconds: DURATION_S,
    rates: RATES,
    trains: IDS.trains.length,
    keys: IDS.keys.length,
  });
}
