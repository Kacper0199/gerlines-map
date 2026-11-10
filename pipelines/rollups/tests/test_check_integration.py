import random
import uuid
from datetime import UTC, date, datetime, timedelta

import psycopg

from gerlines_rollups.check import CHECKED, Result, pending_with_upstream, run_check
from gerlines_rollups.refresh import LEVEL3, refresh, refresh_lands

DAY = date(2026, 10, 27)
NEXT_DAY = DAY + timedelta(days=1)
SOURCES = ("delfi-gtfs-rt", "gtfsde-rt", "cz-czptt-gtfs-rt")
CATEGORIES = ("hsr", "ld", "reg", "rfast", "sbahn")
PLACES = [uuid.uuid5(uuid.NAMESPACE_URL, f"place-{n}") for n in range(8)]

BASE = """
INSERT INTO source (source_id, name, licence, attribution)
  SELECT s, s, 'CC-BY-4.0', 'Test' FROM unnest(%(sources)s::text[]) AS s;
INSERT INTO ingest_run (source_id, job, app_version) SELECT source_id, 'poll', 'test' FROM source;
INSERT INTO raw_object (source_id, ingest_run_id, object_key, sha256, bytes, content_type,
                        fetched_at, http_status)
  SELECT source_id, ingest_run_id, source_id || '/a', repeat('a', 64), 1, 'x', now(), 200
    FROM ingest_run;
INSERT INTO operator (operator_id, name, name_source_id)
  VALUES ('op-a', 'A', 'delfi-gtfs-rt'), ('op-b', 'B', 'delfi-gtfs-rt');
INSERT INTO land_area (land_code, geom, edition, source_url, source_sha256, licence, attribution)
  VALUES ('DE-BY', ST_Multi(ST_MakeEnvelope(600000, 5300000, 700000, 5400000, 25832)), 't', 'u',
          repeat('b', 64), 'l', 'a');
"""


def seed(conn: psycopg.Connection, rng: random.Random, runs: int) -> None:
    for statement in filter(str.strip, BASE.split(";")):
        conn.execute(statement, {"sources": list(SOURCES)} if "%(" in statement else None)
    raw = dict(conn.execute("SELECT source_id, raw_object_id FROM raw_object").fetchall())
    for index, place in enumerate(PLACES):
        conn.execute(
            """INSERT INTO stop_place (stop_place_id, name, name_source_id, geom_source_id,
                                   country_code, geom)
               VALUES (%s, %s, 'delfi-gtfs-rt', 'delfi-gtfs-rt', 'DE',
                       ST_Transform(ST_SetSRID(ST_MakePoint(%s, 5350000), 25832), 4326))""",
            (place, f"P{index}", 640000 + index * 10000),
        )
    start = datetime(2026, 10, 27, 4, 0, tzinfo=UTC)
    for number in range(runs):
        run_id = uuid.uuid5(uuid.NAMESPACE_URL, f"run-{number}")
        category = rng.choice(CATEGORIES)
        stops = rng.sample(PLACES, rng.randint(2, 5))
        origin = start + timedelta(minutes=rng.randint(0, 1200))
        conn.execute(
            """INSERT INTO trip_instance (trip_instance_id, service_date, operator_id, train_number,
                 category_code, origin_stop_place_id, origin_departure, is_added, first_source_id,
                 first_observed_at, first_raw_object_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, true, 'delfi-gtfs-rt', %s, %s)""",
            (
                run_id,
                DAY,
                rng.choice(("op-a", "op-b")),
                str(100 + number % 7),
                category,
                stops[0],
                origin,
                origin,
                raw["delfi-gtfs-rt"],
            ),
        )
        sources = rng.sample(SOURCES, rng.randint(1, 3))
        for source in sources:
            delay = rng.choice((-2400, -600, 0, 30, 359, 360, 900, 959, 960, 4000))
            previous_dep = None
            for stop_index, place in enumerate(stops):
                scheduled = origin + timedelta(minutes=20 * stop_index)
                arrival = scheduled if stop_index else None
                departure = (
                    scheduled + timedelta(minutes=1) if stop_index < len(stops) - 1 else None
                )
                state = rng.random()
                cancelled = state < 0.08
                final = not cancelled and state < 0.85
                delay += rng.choice((-60, 0, 0, 60, 120))
                final_arrival = arrival + timedelta(seconds=delay) if final and arrival else None
                final_departure = (
                    departure + timedelta(seconds=delay + 30) if final and departure else None
                )
                conn.execute(
                    """INSERT INTO stop_event (service_date, trip_instance_id, stop_index,
                         source_id,
                         stop_place_id, scheduled_arrival, scheduled_departure, final_arrival,
                         final_departure, final_quality, prediction_kind, platform_scheduled,
                         platform_actual, cancelled, additional, observed_at, raw_object_id)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               now(), %s)""",
                    (
                        DAY,
                        run_id,
                        stop_index,
                        source,
                        place,
                        arrival,
                        departure,
                        final_arrival,
                        final_departure,
                        rng.choice(("live", "carried"))
                        if final_arrival or final_departure
                        else None,
                        rng.choice(("explicit", "propagated", None)),
                        "1",
                        rng.choice(("1", "2", None)),
                        cancelled,
                        rng.random() < 0.05,
                        raw[source],
                    ),
                )
                if previous_dep is not None and final_arrival is not None:
                    dep_delay, run_sched = previous_dep
                    arr_delay = delay
                    conn.execute(
                        """INSERT INTO segment_obs (service_date, trip_instance_id, from_index,
                             source_id, to_index, from_stop_place_id, to_stop_place_id,
                             dep_delay_from_s, arr_delay_to_s, delay_gain_s, run_sched_s, run_act_s,
                             dwell_delay_s, distance_m, observed_at, raw_object_id)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               now(), %s)""",
                        (
                            DAY,
                            run_id,
                            stop_index - 1,
                            source,
                            stop_index,
                            stops[stop_index - 1],
                            place,
                            dep_delay,
                            arr_delay,
                            arr_delay - dep_delay,
                            run_sched,
                            run_sched + arr_delay - dep_delay,
                            rng.choice((None, 30)),
                            rng.choice((None, 12345.6789, 30000.0)),
                            raw[source],
                        ),
                    )
                previous_dep = (delay + 30, 1140) if final_departure is not None else None


def check(url: str) -> dict[str, str]:
    with psycopg.connect(url) as conn:
        results = run_check(conn, DAY, NEXT_DAY)
    assert [result.name for result in results] == list(CHECKED)
    assert all(result.direct_rows > 0 for result in results)
    return {result.name: result.status for result in results if not result.equal}


def test_rollups_equal_recomputation_including_late_data(database_url: str) -> None:
    rng = random.Random(27)
    with psycopg.connect(database_url, autocommit=True) as conn:
        seed(conn, rng, runs=120)
    assert check(database_url) == dict.fromkeys(CHECKED, "pending")

    with psycopg.connect(database_url, autocommit=True) as conn:
        refresh(conn, None, None)
    assert check(database_url) == {}

    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(
            """UPDATE stop_event SET final_arrival = scheduled_arrival + interval '7 minutes',
                                     final_quality = 'live'
                WHERE scheduled_arrival IS NOT NULL AND NOT cancelled AND stop_index = 1"""
        )
        conn.execute("DELETE FROM segment_obs WHERE from_index = 0 AND source_id = 'gtfsde-rt'")
    stale = check(database_url)
    assert {"stat_stop", "station_day", "land_day", "segment_day"} <= stale.keys()
    assert set(stale.values()) == {"pending"}

    with psycopg.connect(database_url, autocommit=True) as conn:
        refresh(conn, DAY, NEXT_DAY)
    assert check(database_url) == {}


def test_level_three_follows_a_land_change_only_after_the_forced_land_refresh(
    database_url: str,
) -> None:
    rng = random.Random(66)
    with psycopg.connect(database_url, autocommit=True) as conn:
        seed(conn, rng, runs=40)
        refresh(conn, None, None)
        conn.execute(
            """UPDATE stop_place_land
                  SET land_code = 'DE-HB', method = 'nearest', distance_m = 1
                WHERE stop_place_id = (SELECT d.stop_place_id FROM station_day d
                                         JOIN stop_place_land l USING (stop_place_id)
                                        WHERE l.land_code IS DISTINCT FROM 'DE-HB'
                                        GROUP BY 1 ORDER BY sum(d.n_stops) DESC LIMIT 1)"""
        )
    assert check(database_url) == dict.fromkeys(LEVEL3, "unequal")

    with psycopg.connect(database_url, autocommit=True) as conn:
        refreshed = refresh_lands(conn)
    assert [item.name for item in refreshed] == list(LEVEL3)
    assert check(database_url) == {}


def test_level_two_is_pending_while_its_level_one_rollup_is() -> None:
    own = {"stat_stop": 2, "segment_day": 1}
    assert pending_with_upstream(own, "land_day") == 2
    assert pending_with_upstream(own, "segment_day") == 1
    assert pending_with_upstream(own, "stat_segment") == 0


def test_a_difference_without_pending_ranges_is_unequal() -> None:
    assert Result("station_day", 3, 3, 1, 1, pending=0).status == "unequal"
    assert Result("station_day", 3, 3, 1, 1, pending=4).status == "pending"
    assert Result("station_day", 3, 3, 0, 0, pending=4).status == "equal"
