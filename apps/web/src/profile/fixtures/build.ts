/**
 * Builds segments-619-hsr.json: the answer of GET /api/v1/stats/trains/619/segments, produced by the API's own
 * StatsService over golden rollup rows (the segment_day and stat_segment shapes of the API tests) on the stop
 * places of the ice-delay train fixture. The counts are test data chosen to cover every state of the profile
 * (medians below, at and above the all-trains figure, a leg with too few runs, an off-route leg, a second
 * place id for the same stop); no figure here is a measurement.
 *
 * Run: node apps/web/src/profile/fixtures/build.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATS_GAIN_BINS } from "@gerlines/schema/stats";
import { StatsService } from "../../../../api/src/stats/service.ts";
import { GoldenReader } from "../../../../api/src/stats/test-data.ts";
import ice from "../../components/train/fixtures/ice-delay.json" with { type: "json" };

type SegmentRow = GoldenReader["segments"]["rows"][number];
type SegmentLegTotals = NonNullable<SegmentRow["train"]>;

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-27T05:00:00Z");
const stops = ice.detail.stops as { stopPlaceId: string; name: string }[];

const cells = (counts: Record<number, number>) => [
  0,
  ...STATS_GAIN_BINS.map((_, bin) => counts[bin] ?? 0),
  0,
];

function legs(runs: number, counts: Record<number, number>, sumGainS: number): SegmentLegTotals {
  const n = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    n_runs: runs,
    n_legs: n,
    sum_gain_s: sumGainS,
    gain_hist: cells(counts),
    n_speed: 0,
    sum_distance_m: null,
    sum_run_act_s: null,
    speed_hist: null,
  };
}

const TRAIN: Record<number, [number, Record<number, number>, number] | null> = {
  0: [24, { 7: 22, 8: 2 }, 80],
  1: [24, { 7: 24 }, 0],
  2: [24, { 7: 10, 8: 8, 9: 6 }, 760],
  3: [3, { 8: 3 }, 180],
  4: [24, { 6: 6, 7: 12, 8: 6 }, 0],
  5: [24, { 7: 14, 8: 6, 10: 4 }, 920],
  6: [24, { 7: 12, 8: 8, 9: 4 }, 560],
  7: [24, { 8: 10, 9: 8, 10: 6 }, 2200],
  8: [24, { 7: 6, 9: 12, 11: 6 }, 2300],
  9: [24, { 7: 10, 8: 8, 9: 6 }, 760],
  10: null,
  11: [24, { 5: 4, 6: 10, 7: 10 }, -420],
  12: [24, { 7: 18, 8: 6 }, 360],
  13: [24, { 7: 8, 8: 10, 10: 6 }, 1480],
  14: [24, { 9: 10, 10: 8, 12: 6 }, 3500],
  15: [24, { 7: 20, 8: 4 }, 240],
  16: [24, { 7: 12, 8: 8, 9: 4 }, 560],
  17: [24, { 6: 4, 7: 14, 8: 6 }, 120],
  18: [24, { 7: 16, 8: 8 }, 480],
  19: [24, { 8: 12, 9: 8, 11: 4 }, 2000],
  20: [24, { 6: 8, 7: 12, 8: 4 }, -120],
};

const ALL: Record<number, [number, Record<number, number>]> = {
  0: [900, { 7: 700, 8: 160, 9: 40 }],
  1: [900, { 7: 820, 8: 80 }],
  2: [900, { 7: 360, 8: 300, 9: 160, 10: 80 }],
  3: [880, { 7: 500, 8: 280, 9: 100 }],
  4: [900, { 6: 100, 7: 560, 8: 200, 9: 40 }],
  5: [900, { 7: 420, 8: 300, 9: 180 }],
  6: [900, { 7: 460, 8: 280, 9: 160 }],
  7: [900, { 7: 380, 8: 280, 9: 160, 10: 80 }],
  8: [900, { 6: 60, 7: 360, 8: 300, 9: 180 }],
  9: [900, { 7: 460, 8: 260, 9: 180 }],
  10: [890, { 7: 500, 8: 250, 9: 140 }],
  11: [900, { 6: 120, 7: 560, 8: 220 }],
  12: [900, { 7: 540, 8: 260, 9: 100 }],
  13: [900, { 7: 440, 8: 280, 9: 120, 10: 60 }],
  14: [900, { 7: 300, 8: 260, 9: 200, 10: 140 }],
  15: [900, { 7: 600, 8: 220, 9: 80 }],
  16: [900, { 7: 480, 8: 260, 9: 160 }],
  17: [900, { 6: 100, 7: 520, 8: 240, 9: 40 }],
  18: [900, { 7: 500, 8: 280, 9: 120 }],
  19: [900, { 7: 380, 8: 260, 9: 180, 10: 80 }],
  20: [900, { 6: 100, 7: 560, 8: 240 }],
};

const rows: SegmentRow[] = stops.slice(0, -1).flatMap((from, index) => {
  const to = stops[index + 1];
  const train = TRAIN[index];
  const all = ALL[index];
  if (!to || !all) return [];
  return [
    {
      from_stop_place_id: from.stopPlaceId,
      to_stop_place_id: to.stopPlaceId,
      from_name: from.name,
      to_name: to.name,
      route_index: index,
      train: train ? legs(...train) : null,
      all: legs(...all, 0),
    },
  ] as SegmentRow[];
});

rows.push({
  from_stop_place_id: stops[2]?.stopPlaceId as string,
  to_stop_place_id: stops[4]?.stopPlaceId as string,
  from_name: "Hamburg Hbf",
  to_name: "Bremen Hbf",
  route_index: null,
  train: legs(2, { 8: 2 }, 120),
  all: legs(40, { 7: 30, 8: 10 }, 0),
});

const reader = new GoldenReader({});
reader.segments = {
  runs: 26,
  patternRuns: 24,
  pairs: rows.length,
  groups: [
    {
      category_code: "hsr",
      operator_id: "db-fernverkehr-ag",
      operator_name: "DB Fernverkehr AG",
      runs: 26,
    },
    { category_code: "reg", operator_id: null, operator_name: null, runs: 9 },
  ],
  rows,
};

const answer = await new StatsService(reader, () => NOW).trainSegments("619", "db-fernverkehr-ag", {
  from: "2026-09-28",
  to: "2026-10-27",
  categories: ["hsr"],
});

writeFileSync(join(here, "segments-619-hsr.json"), `${JSON.stringify(answer, null, 2)}\n`);
process.stdout.write(`wrote ${answer.segments.length} segments\n`);
