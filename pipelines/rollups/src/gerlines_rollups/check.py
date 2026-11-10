"""Recomputation check: every rollup against a direct query over the raw realtime tables.

The direct queries deduplicate sources with DISTINCT ON instead of ``first()``, bin values with CASE
expressions written from :mod:`gerlines_rollups.spec` instead of the migration's bin functions, and
count histogram bins with FILTER instead of TimescaleDB's ``histogram()``. A rollup passes when the
multiset of its rows over the window equals the direct result in both directions. Every query
runs in one REPEATABLE READ snapshot. A rollup that differs while TimescaleDB still logs
invalidations for the window (its own or those of the level-1 rollup it reads) is reported as
pending, not unequal.
"""

from dataclasses import dataclass, field
from datetime import date

import psycopg
from psycopg import sql

from gerlines_rollups.refresh import LEVEL3, present_rollups, refuse_archived
from gerlines_rollups.spec import DELAY, GAIN, SPEED, Bins, bin_case_sql, source_order_sql

SAMPLE_ROWS = 5
LOCAL_ZONE = "Europe/Berlin"


def _delay_s(final: str, scheduled: str) -> str:
    return (
        f"CASE WHEN NOT e.cancelled AND e.{final} IS NOT NULL AND e.{scheduled} IS NOT NULL "
        f"THEN round(extract(epoch FROM e.{final} - e.{scheduled}))::integer END"
    )


def _no_early(column: str) -> str:
    return f"CASE WHEN {column} >= {DELAY.lowest} THEN {column} END"


DIRECT_STOP = f"""
CREATE TEMP TABLE direct_stop AS
WITH e AS (
  SELECT e.service_date AS day, e.trip_instance_id, e.stop_index, e.source_id, e.stop_place_id,
         ti.category_code, ti.operator_id, ti.train_number, r.short_name AS line_name,
         e.cancelled OR e.final_quality IS NOT NULL AS decided,
         e.additional, e.cancelled, e.final_quality, e.prediction_kind,
         extract(hour FROM coalesce(e.scheduled_arrival, e.scheduled_departure, e.final_arrival,
           e.final_departure, e.predicted_arrival, e.predicted_departure)
           AT TIME ZONE '{LOCAL_ZONE}')::smallint AS local_hour,
         {_delay_s("final_arrival", "scheduled_arrival")} AS arr_raw,
         {_delay_s("final_departure", "scheduled_departure")} AS dep_raw,
         e.scheduled_arrival IS NOT NULL AS has_arrival,
         e.platform_actual IS NOT NULL AND e.platform_scheduled IS NOT NULL
           AND e.platform_actual <> e.platform_scheduled AS platform_changed
    FROM stop_event e
    JOIN trip_instance ti ON ti.trip_instance_id = e.trip_instance_id
    LEFT JOIN trip t ON t.feed_version_id = ti.feed_version_id AND t.trip_key = ti.trip_key
    LEFT JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
   WHERE e.service_date >= {{start}} AND e.service_date < {{end}}
),
grouped AS (
  SELECT day, trip_instance_id, stop_index, category_code, operator_id, train_number, line_name,
         count(*)::smallint AS n_sources, bool_or(additional) AS additional
    FROM e GROUP BY 1, 2, 3, 4, 5, 6, 7
),
best AS (
  SELECT DISTINCT ON (day, trip_instance_id, stop_index) *
    FROM e ORDER BY day, trip_instance_id, stop_index,
         {source_order_sql("category_code", "source_id", "final_quality")}
),
chosen AS (
  SELECT DISTINCT ON (day, trip_instance_id, stop_index) *
    FROM e WHERE decided ORDER BY day, trip_instance_id, stop_index,
         {source_order_sql("category_code", "source_id", "final_quality")}
)
SELECT g.day, g.trip_instance_id, g.stop_index, g.category_code, g.operator_id, g.train_number,
       g.line_name, coalesce(c.stop_place_id, b.stop_place_id) AS stop_place_id, c.source_id,
       g.n_sources, g.additional, c.cancelled, c.final_quality, c.prediction_kind, b.local_hour,
       {_no_early("c.arr_raw")} AS arr_delay_s,
       {_no_early("c.dep_raw")} AS dep_delay_s,
       CASE WHEN c.has_arrival THEN {_no_early("c.arr_raw")} ELSE {_no_early("c.dep_raw")} END
         AS stop_delay_s,
       c.platform_changed
  FROM grouped g
  JOIN best b USING (day, trip_instance_id, stop_index)
  LEFT JOIN chosen c USING (day, trip_instance_id, stop_index)
"""

DIRECT_SEGMENT = f"""
CREATE TEMP TABLE direct_segment AS
WITH s AS (
  SELECT s.service_date AS day, s.*, ti.category_code, ti.operator_id, ti.train_number,
         r.short_name AS line_name
    FROM segment_obs s
    JOIN trip_instance ti ON ti.trip_instance_id = s.trip_instance_id
    LEFT JOIN trip t ON t.feed_version_id = ti.feed_version_id AND t.trip_key = ti.trip_key
    LEFT JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
   WHERE s.service_date >= {{start}} AND s.service_date < {{end}}
),
counted AS (
  SELECT day, trip_instance_id, from_index, count(*)::smallint AS n_sources FROM s GROUP BY 1, 2, 3
),
best AS (
  SELECT DISTINCT ON (day, trip_instance_id, from_index) *
    FROM s ORDER BY day, trip_instance_id, from_index,
         {source_order_sql("category_code", "source_id", None)}
)
SELECT b.day, b.trip_instance_id, b.from_index, b.category_code, b.operator_id, b.train_number,
       b.line_name, b.source_id, c.n_sources, b.to_index, b.from_stop_place_id, b.to_stop_place_id,
       b.dep_delay_from_s, b.arr_delay_to_s, b.delay_gain_s, b.run_sched_s, b.run_act_s,
       b.dwell_delay_s, b.distance_m
  FROM best b JOIN counted c USING (day, trip_instance_id, from_index)
"""


def _hist_direct(bins: Bins, expression: str, condition: str = "true") -> str:
    case = bin_case_sql(bins, expression)
    counts = ", ".join(
        f"count(*) FILTER (WHERE {condition} AND {case} = {index})" for index in range(bins.count)
    )
    return f"ARRAY[{counts}]::bigint[]"


def _hist_rollup(bins: Bins, column: str) -> str:
    return f"coalesce(stat_hist_counts({column}), array_fill(0::bigint, ARRAY[{bins.count}]))"


STOP_MEASURES = [
    ("n_stops", "count(*)"),
    ("n_cancelled", "count(*) FILTER (WHERE cancelled)"),
    ("n_additional", "count(*) FILTER (WHERE additional)"),
    ("n_no_data", "count(*) FILTER (WHERE source_id IS NULL)"),
    ("n_carried", "count(*) FILTER (WHERE final_quality = 'carried' AND NOT cancelled)"),
    ("n_observed", "count(stop_delay_s)"),
    ("n_lt_6min", "count(*) FILTER (WHERE stop_delay_s < 360)"),
    ("n_lt_16min", "count(*) FILTER (WHERE stop_delay_s < 960)"),
    ("n_observed_arr", "count(stop_delay_s) FILTER (WHERE stop_index > 0)"),
    ("n_lt_6min_arr", "count(*) FILTER (WHERE stop_index > 0 AND stop_delay_s < 360)"),
    ("n_lt_16min_arr", "count(*) FILTER (WHERE stop_index > 0 AND stop_delay_s < 960)"),
    ("n_observed_carried", "count(stop_delay_s) FILTER (WHERE final_quality = 'carried')"),
    ("n_observed_propagated", "count(stop_delay_s) FILTER (WHERE prediction_kind = 'propagated')"),
    ("sum_delay_s", "sum(stop_delay_s)::bigint"),
    ("sum_delay_pos_s", "sum(greatest(stop_delay_s, 0))::bigint"),
    ("max_delay_s", "max(stop_delay_s)"),
    ("n_platform_changed", "count(*) FILTER (WHERE platform_changed)"),
]
RUNS = [("n_runs", "count(DISTINCT trip_instance_id)")]
DEPARTURES = [
    ("n_dep_observed", "count(dep_delay_s)"),
    ("n_dep_lt_6min", "count(*) FILTER (WHERE dep_delay_s < 360)"),
]
SPEED_ROW = "distance_m IS NOT NULL AND run_act_s > 0 AND run_sched_s > 0"
SEGMENT_MEASURES = [
    ("n_legs", "count(*)"),
    ("n_runs", "count(DISTINCT trip_instance_id)"),
    ("sum_gain_s", "sum(delay_gain_s)::bigint"),
    ("n_gain_pos", "count(*) FILTER (WHERE delay_gain_s > 0)"),
    ("n_gain_neg", "count(*) FILTER (WHERE delay_gain_s < 0)"),
    ("n_arr_lt_6min", "count(*) FILTER (WHERE arr_delay_to_s < 360)"),
    ("sum_arr_delay_s", "sum(arr_delay_to_s)::bigint"),
    ("sum_run_sched_s", "sum(run_sched_s)::bigint"),
    ("sum_run_act_s", "sum(run_act_s)::bigint"),
    ("n_dwell", "count(dwell_delay_s)"),
    ("sum_dwell_delay_s", "sum(dwell_delay_s)::bigint"),
    ("n_speed", f"count(*) FILTER (WHERE {SPEED_ROW})"),
    ("sum_distance_m", f"round((sum(distance_m) FILTER (WHERE {SPEED_ROW}))::numeric, 3)"),
    ("sum_speed_run_act_s", f"sum(run_act_s) FILTER (WHERE {SPEED_ROW})"),
    ("sum_speed_run_sched_s", f"sum(run_sched_s) FILTER (WHERE {SPEED_ROW})"),
]


@dataclass(frozen=True, slots=True)
class Rollup:
    name: str
    keys: tuple[str, ...]
    measures: tuple[tuple[str, str], ...]
    hists: tuple[tuple[str, Bins, str, str], ...] = ()
    source: str = "direct_stop"
    join: str = ""
    rollup_overrides: dict[str, str] = field(default_factory=dict)

    def rollup_query(self) -> str:
        columns = [*self.keys]
        for name, _ in self.measures:
            columns.append(self.rollup_overrides.get(name, name))
        columns += [_hist_rollup(bins, name) for name, bins, _, _ in self.hists]
        return (
            f"SELECT {', '.join(columns)} FROM {self.name} WHERE day >= {{start}} AND day < {{end}}"
        )

    def direct_query(self) -> str:
        columns = [*self.keys]
        columns += [expression for _, expression in self.measures]
        columns += [_hist_direct(bins, value, cond) for _, bins, value, cond in self.hists]
        group = ", ".join(str(index + 1) for index in range(len(self.keys)))
        return f"SELECT {', '.join(columns)} FROM {self.source} s{self.join} GROUP BY {group}"


STOP_HIST = ("delay_hist", DELAY, "stop_delay_s", "true")
LAND_JOIN = " LEFT JOIN stop_place_land l ON l.stop_place_id = s.stop_place_id"

LEVEL1_STOP_COLUMNS = (
    "day, trip_instance_id, stop_index, category_code, operator_id, train_number, line_name, "
    "stop_place_id, source_id, n_sources, additional, cancelled, final_quality, prediction_kind, "
    "local_hour, "
    "arr_delay_s, dep_delay_s, stop_delay_s, platform_changed"
)
LEVEL1_SEGMENT_COLUMNS = (
    "day, trip_instance_id, from_index, category_code, operator_id, train_number, line_name, "
    "source_id, n_sources, to_index, from_stop_place_id, to_stop_place_id, dep_delay_from_s, "
    "arr_delay_to_s, delay_gain_s, run_sched_s, run_act_s, dwell_delay_s, "
    "round(distance_m::numeric, 3) AS distance_m"
)

ROLLUPS: tuple[Rollup, ...] = (
    Rollup(
        "station_day",
        ("day", "stop_place_id", "category_code", "operator_id"),
        (*STOP_MEASURES, *DEPARTURES),
        (STOP_HIST, ("dep_delay_hist", DELAY, "dep_delay_s", "true")),
    ),
    Rollup(
        "station_hour",
        ("day", "stop_place_id", "local_hour", "category_code"),
        tuple(STOP_MEASURES),
        (STOP_HIST,),
    ),
    Rollup(
        "train_day",
        ("day", "operator_id", "train_number", "category_code", "line_name"),
        (*RUNS, *STOP_MEASURES),
        (STOP_HIST,),
    ),
    Rollup(
        "line_day",
        ("day", "operator_id", "line_name", "category_code"),
        (*RUNS, *STOP_MEASURES),
        (STOP_HIST,),
    ),
    Rollup(
        "land_day",
        ("day", "land_code", "category_code", "operator_id"),
        tuple(STOP_MEASURES),
        (STOP_HIST,),
        join=LAND_JOIN,
    ),
    Rollup(
        "land_hour",
        ("day", "land_code", "local_hour", "category_code"),
        tuple(STOP_MEASURES),
        (STOP_HIST,),
        join=LAND_JOIN,
    ),
    Rollup(
        "land_category_day",
        ("day", "land_code", "category_code"),
        tuple(STOP_MEASURES),
        (STOP_HIST,),
        join=LAND_JOIN,
    ),
    Rollup(
        "land_category_hour",
        ("day", "land_code", "local_hour", "category_code"),
        tuple(STOP_MEASURES),
        join=LAND_JOIN,
    ),
    Rollup(
        "segment_day",
        ("day", "from_stop_place_id", "to_stop_place_id", "category_code"),
        tuple(SEGMENT_MEASURES),
        (
            ("gain_hist", GAIN, "delay_gain_s", "true"),
            ("arr_delay_hist", DELAY, "arr_delay_to_s", "true"),
            ("speed_hist", SPEED, "distance_m / run_act_s * 3.6", SPEED_ROW),
        ),
        source="direct_segment",
        rollup_overrides={"sum_distance_m": "round(sum_distance_m::numeric, 3)"},
    ),
)


CHECKED: tuple[str, ...] = ("stat_stop", "stat_segment", *(rollup.name for rollup in ROLLUPS))

UPSTREAM = {
    "station_day": "stat_stop",
    "station_hour": "stat_stop",
    "train_day": "stat_stop",
    "line_day": "stat_stop",
    "segment_day": "stat_segment",
    "land_day": "station_day",
    "land_hour": "station_hour",
    "land_category_day": "station_day",
    "land_category_hour": "station_hour",
}

PENDING = """
SELECT ca.user_view_name::text,
       (SELECT count(*) FROM _timescaledb_catalog.continuous_aggs_hypertable_invalidation_log h
         WHERE h.hypertable_id = ca.raw_hypertable_id
           AND h.lowest_modified_value < {end} AND h.greatest_modified_value >= {start})
     + (SELECT count(*) FROM _timescaledb_catalog.continuous_aggs_materialization_invalidation_log m
         WHERE m.materialization_id = ca.mat_hypertable_id
           AND m.lowest_modified_value < {end} AND m.greatest_modified_value >= {start})
  FROM _timescaledb_catalog.continuous_agg ca
"""

EPOCH = date(1970, 1, 1)
MICROSECONDS_PER_DAY = 86_400_000_000


def internal_time(day: date) -> int:
    """TimescaleDB's internal value of a date: microseconds since the Unix epoch."""
    return (day - EPOCH).days * MICROSECONDS_PER_DAY


def pending_with_upstream(own: dict[str, int], name: str) -> int:
    """Invalidation ranges logged for ``name`` or for any rollup it reads, over the window."""
    count = own.get(name, 0)
    while name in UPSTREAM:
        name = UPSTREAM[name]
        count += own.get(name, 0)
    return count


@dataclass(slots=True)
class Result:
    name: str
    rollup_rows: int
    direct_rows: int
    only_in_rollup: int
    only_in_direct: int
    samples_rollup: list[tuple] = field(default_factory=list)
    samples_direct: list[tuple] = field(default_factory=list)
    pending: int = 0

    @property
    def equal(self) -> bool:
        return self.only_in_rollup == 0 and self.only_in_direct == 0

    @property
    def status(self) -> str:
        if self.equal:
            return "equal"
        return "pending" if self.pending else "unequal"

    def as_dict(self) -> dict:
        return {
            "rollup": self.name,
            "rollup_rows": self.rollup_rows,
            "direct_rows": self.direct_rows,
            "only_in_rollup": self.only_in_rollup,
            "only_in_direct": self.only_in_direct,
            "equal": self.equal,
            "pending_ranges": self.pending,
            "status": self.status,
            "samples_rollup": [list(map(str, row)) for row in self.samples_rollup],
            "samples_direct": [list(map(str, row)) for row in self.samples_direct],
        }


def _render(template: str, start: date, end: date) -> sql.Composed:
    return sql.SQL(template).format(start=sql.Literal(start), end=sql.Literal(end))


def _compare(
    cur: psycopg.Cursor, name: str, rollup: sql.Composable, direct: sql.Composable
) -> Result:
    counts = sql.SQL(
        "WITH r AS ({rollup}), d AS ({direct})"
        " SELECT (SELECT count(*) FROM r), (SELECT count(*) FROM d),"
        " (SELECT count(*) FROM (SELECT * FROM r EXCEPT ALL SELECT * FROM d) x),"
        " (SELECT count(*) FROM (SELECT * FROM d EXCEPT ALL SELECT * FROM r) x)"
    ).format(rollup=rollup, direct=direct)
    rollup_rows, direct_rows, only_rollup, only_direct = cur.execute(counts).fetchone()
    result = Result(name, rollup_rows, direct_rows, only_rollup, only_direct)
    if not result.equal:
        sample = sql.SQL("({a}) EXCEPT ALL ({b}) LIMIT {n}")
        result.samples_rollup = cur.execute(
            sample.format(a=rollup, b=direct, n=sql.Literal(SAMPLE_ROWS))
        ).fetchall()
        result.samples_direct = cur.execute(
            sample.format(a=direct, b=rollup, n=sql.Literal(SAMPLE_ROWS))
        ).fetchall()
    return result


def run_check(conn: psycopg.Connection, start: date, end: date) -> list[Result]:
    """Compare every rollup with its direct recomputation for service days in [start, end).

    Archived days have no raw rows to recompute from, so a range with one is refused."""
    results: list[Result] = []
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        refuse_archived(conn, start, end, "the check")
        missing = set(LEVEL3) - set(present_rollups(conn, LEVEL3))
        own = dict(
            cur.execute(
                sql.SQL(PENDING).format(
                    start=sql.Literal(internal_time(start)), end=sql.Literal(internal_time(end))
                )
            ).fetchall()
        )
        cur.execute(_render(DIRECT_STOP, start, end))
        cur.execute(_render(DIRECT_SEGMENT, start, end))
        results.append(
            _compare(
                cur,
                "stat_stop",
                _render(
                    f"SELECT {LEVEL1_STOP_COLUMNS} FROM stat_stop "
                    "WHERE day >= {start} AND day < {end}",
                    start,
                    end,
                ),
                sql.SQL(f"SELECT {LEVEL1_STOP_COLUMNS} FROM direct_stop"),
            )
        )
        results.append(
            _compare(
                cur,
                "stat_segment",
                _render(
                    f"SELECT {LEVEL1_SEGMENT_COLUMNS} FROM stat_segment "
                    "WHERE day >= {start} AND day < {end}",
                    start,
                    end,
                ),
                sql.SQL(f"SELECT {LEVEL1_SEGMENT_COLUMNS} FROM direct_segment"),
            )
        )
        results.extend(
            _compare(
                cur,
                rollup.name,
                _render(rollup.rollup_query(), start, end),
                sql.SQL(rollup.direct_query()),
            )
            for rollup in ROLLUPS
            if rollup.name not in missing
        )
        cur.execute("DROP TABLE direct_stop, direct_segment")
    for result in results:
        result.pending = pending_with_upstream(own, result.name)
    return results
