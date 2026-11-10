import { createDatabase } from "@gerlines/db";
import { TrainDetail } from "@gerlines/schema";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { routeProduct } from "./product.ts";
import { buildAll } from "./publisher.ts";
import { DetailRepository, type ReadMode } from "./repository.ts";
import { runningAt } from "./running.ts";

/**
 * Read-only checks against a replay database (GERLINES_DETAIL_DATABASE_URL, for example
 * gerlines_wp32b with WP-2.3's replay of 2026-10-27 02:28Z to 02:58Z); skipped without one.
 */
const databaseUrl = process.env.GERLINES_DETAIL_DATABASE_URL;
const AT = Date.parse(process.env.GERLINES_DETAIL_AT ?? "2026-10-27T03:00:00Z");

const LONG_DISTANCE = new Set(["hsr", "ld", "night"]);
/**
 * Long-distance lines that neither gtfs.de nor the DELFI route name gives a product, counted over
 * the 2026-10-26 feed (version 3): hsr 116 of 6,057 trips (lines 20, 84), ld 81 of 2,419 (24, 27,
 * 89, DRF), night 264 of 1,286 (27N, 91N, DRF); version 1 also has ld 33.
 */
const KNOWN_WITHOUT_PRODUCT = new Set(["20", "24", "27", "27N", "33", "84", "89", "91N", "DRF"]);
const MAIN_STATION = /^(Hauptbahnhof|Hbf|Bahnhof|Bf)$/;
const GENERIC_NAMES = new Set(["Ostbahnhof", "Westbahnhof", "Südbahnhof", "Nordbahnhof", "ZOB"]);
/** Places without an EVA number keep the feed's generic name until display names with their town are built. */
const KNOWN_GENERIC = new Set(["Ostbahnhof"]);

describe.skipIf(!databaseUrl)("train details over every running train of a replay", () => {
  const db = createDatabase({
    databaseUrl: databaseUrl ?? "postgres://unused/unused",
    applicationName: "gerlines-live-detail-test",
    maxConnections: 4,
  });
  const repository = new DetailRepository(db);
  afterAll(() => db.destroy());

  async function render(mode: ReadMode) {
    const refs = await runningAt(db, AT);
    const loaded = await repository.load(refs, AT, mode);
    const report = buildAll(loaded, {
      asOf: AT,
      version: 1,
      timetableVersion: (instance) => String(instance.ref.feedVersionId ?? 0),
    });
    return { refs, report };
  }

  it("builds a schema-valid detail for every running train", async () => {
    const { refs, report } = await render("history");
    expect(refs.length).toBeGreaterThan(100);
    expect(report.failures).toEqual({});
    expect(report.details).toHaveLength(refs.length);
    for (const detail of report.details) TrainDetail.parse(detail);
  });

  it("meets the card's gates: products, towns, platforms, no data apart from zero", async () => {
    const { report } = await render("history");
    const details = report.details;
    const stops = details.flatMap((detail) => detail.stops);
    const platforms = stops.flatMap((stop) => [stop.platformScheduled, stop.platformActual]);
    const missingProduct = details.filter(
      (d) =>
        d.productName === null &&
        (routeProduct(d.line) !== null ||
          (LONG_DISTANCE.has(d.category) && !KNOWN_WITHOUT_PRODUCT.has(d.line ?? ""))),
    );
    expect(missingProduct.map((d) => `${d.category} ${d.line}`)).toEqual([]);
    expect(
      details.filter((d) => d.provenance.kind === "timetable" && d.delaySeconds !== null),
    ).toEqual([]);
    expect(stops.filter((stop) => MAIN_STATION.test(stop.name))).toEqual([]);
    const generic = new Set(
      stops.map((stop) => stop.name).filter((name) => GENERIC_NAMES.has(name)),
    );
    expect([...generic].filter((name) => !KNOWN_GENERIC.has(name))).toEqual([]);
    expect(
      platforms.filter((value) => value !== null && /^(Gl|Gleis|Bstg|G\d)/.test(value)),
    ).toEqual([]);
  });

  it("lists only the stops where the train picks up or sets down passengers", async () => {
    const { refs, report } = await render("history");
    const timetabled = refs.filter((ref) => ref.feedVersionId !== null && ref.tripKey !== null);
    const flags = await sql<{
      feed_version_id: number;
      trip_key: string;
      stop_index: number;
      passenger: boolean;
    }>`
      SELECT st.feed_version_id, st.trip_key, st.stop_index,
             NOT (st.pickup_type = 1 AND st.drop_off_type = 1) AS passenger
        FROM unnest(${timetabled.map((ref) => ref.feedVersionId)}::int[],
                    ${timetabled.map((ref) => ref.tripKey)}::text[]) AS wanted (feed_version_id, trip_key)
        JOIN stop_time st USING (feed_version_id, trip_key)`.execute(db);
    const expected = new Map<string, number[]>();
    let passThrough = 0;
    for (const row of flags.rows) {
      const key = `${row.feed_version_id}:${row.trip_key}`;
      if (!expected.has(key)) expected.set(key, []);
      if (row.passenger) expected.get(key)?.push(row.stop_index);
      else passThrough += 1;
    }
    expect(passThrough).toBeGreaterThan(0);
    const byId = new Map(timetabled.map((ref) => [ref.tripInstanceId, ref]));
    const wrong = report.details.filter((detail) => {
      const ref = byId.get(detail.tripInstanceId);
      if (!ref) return false;
      const want = (expected.get(`${ref.feedVersionId}:${ref.tripKey}`) ?? []).sort(
        (a, b) => a - b,
      );
      return JSON.stringify(detail.stops.map((stop) => stop.index)) !== JSON.stringify(want);
    });
    expect(wrong.map((detail) => detail.tripInstanceId)).toEqual([]);
    expect(
      report.details.filter((detail) => byId.has(detail.tripInstanceId)).length,
    ).toBeGreaterThan(100);
  });

  it("reads the same stop state from the forecasts as from the folded state after the replay", async () => {
    const history = await render("history");
    const current = await render("current");
    const key = (detail: TrainDetail) =>
      JSON.stringify(
        detail.stops.map((stop) => [
          stop.index,
          stop.predictedArrival,
          stop.predictedDeparture,
          stop.arrivalDelaySeconds,
          stop.departureDelaySeconds,
          stop.cancelled,
          stop.platformActual,
        ]),
      );
    const byId = new Map(current.report.details.map((detail) => [detail.tripInstanceId, detail]));
    const differing = history.report.details.filter((detail) => {
      const other = byId.get(detail.tripInstanceId);
      return (
        !other ||
        key(other) !== key(detail) ||
        other.provenance.sourceId !== detail.provenance.sourceId
      );
    });
    expect(differing.map((detail) => detail.tripInstanceId)).toEqual([]);
  });
});
