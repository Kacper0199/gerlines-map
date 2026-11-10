import { writeFileSync } from "node:fs";

const usage =
  "usage: node scripts/record-router-fixture.mjs <motis base url> <out.json> <plan query string>";
const [base, out, query] = process.argv.slice(2);
if (!base || !out || !query) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const DROPPED_LEG_KEYS = [
  "legGeometry",
  "intermediateStops",
  "steps",
  "alerts",
  "fareTransferIndex",
  "source",
];
const FIXED_PARAMS = { detailedLegs: "false", joinInterlinedLegs: "false" };
const DROPPED_TOP_KEYS = ["direct", "fromPlace", "toPlace", "requestParameters", "debugOutput"];

const url = new URL(`/api/v6/plan?${query}`, base);
for (const [key, value] of Object.entries(FIXED_PARAMS)) {
  url.searchParams.set(key, value);
}
const response = await fetch(url, { headers: { Accept: "application/json" } });
if (!response.ok) {
  process.stderr.write(`MOTIS answered ${response.status}: ${await response.text()}\n`);
  process.exit(1);
}
const plan = await response.json();
for (const key of DROPPED_TOP_KEYS) {
  delete plan[key];
}
for (const itinerary of plan.itineraries) {
  delete itinerary.fareTransfers;
  for (const leg of itinerary.legs) {
    for (const key of DROPPED_LEG_KEYS) {
      delete leg[key];
    }
  }
}
const fixture = {
  description:
    "MOTIS 2.11.4 /api/v6/plan over the DELFI GTFS of 2026-10-19 (enriched), run delfi-2026-10-19-rail",
  request: `${url.pathname}${url.search}`,
  response: plan,
};
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`wrote ${out}: ${plan.itineraries.length} itineraries\n`);
