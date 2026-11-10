"""Coverage of a loaded timetable by the catalogue, read from a feed database in read-only mode.

Weights are the trips of one reference service day and their train-km, where train-km is the
sum of great-circle distances between consecutive stops of the trip's pattern (a lower bound of
the distance along the track; stops without coordinates add nothing).
"""

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date

import psycopg

from gerlines_catalog.models import SERIES_EXPLAINED_FIELDS
from gerlines_catalog.seeds import Catalog

TRAIN_CATEGORIES = ("hsr", "ld", "night", "rfast", "reg", "sbahn")
_SPACES = re.compile(r"[\s\-_]+")


@dataclass(frozen=True, slots=True)
class RouteDay:
    route_key: str
    agency_key: str | None
    operator_id: str | None
    short_name: str | None
    category_code: str
    is_foreign: bool
    trips: int
    train_km: float


def line_key(name: str | None) -> str:
    return _SPACES.sub("", name or "").upper()


ROUTE_DAY_SQL = """
WITH active AS (
  SELECT c.service_key
    FROM service_calendar c
   WHERE c.feed_version_id = %(v)s
     AND c.start_date <= %(d)s AND c.end_date >= %(d)s
     AND ((c.weekdays >> (extract(isodow FROM %(d)s::date)::int - 1)) & 1) = 1
     AND NOT EXISTS (
       SELECT 1 FROM service_calendar_date x
        WHERE x.feed_version_id = c.feed_version_id AND x.service_key = c.service_key
          AND x.service_date = %(d)s AND x.exception_type = 2)
  UNION
  SELECT service_key FROM service_calendar_date
   WHERE feed_version_id = %(v)s AND service_date = %(d)s AND exception_type = 1
),
legs AS (
  SELECT ps.trip_pattern_id,
         ST_Distance(sp.geom::geography,
                     lag(sp.geom::geography) OVER (
                       PARTITION BY ps.trip_pattern_id ORDER BY ps.stop_index)) AS metres
    FROM trip_pattern_stop ps
    JOIN stop_point sp USING (stop_point_id)
   WHERE ps.feed_version_id = %(v)s
),
pattern_km AS (
  SELECT trip_pattern_id, COALESCE(sum(metres), 0) / 1000.0 AS km FROM legs GROUP BY 1
)
SELECT r.route_key, r.agency_key, r.operator_id, r.short_name, r.category_code, r.is_foreign,
       count(*) AS trips, COALESCE(sum(k.km), 0) AS train_km
  FROM trip t
  JOIN active a USING (service_key)
  JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
  LEFT JOIN pattern_km k ON k.trip_pattern_id = t.trip_pattern_id
 WHERE t.feed_version_id = %(v)s AND r.category_code = ANY(%(c)s)
 GROUP BY 1, 2, 3, 4, 5, 6
"""


def route_days(conn: psycopg.Connection, feed_version: int, day: date) -> list[RouteDay]:
    rows = conn.execute(
        ROUTE_DAY_SQL, {"v": feed_version, "d": day, "c": list(TRAIN_CATEGORIES)}
    ).fetchall()
    return [
        RouteDay(r[0], r[1], r[2], r[3], r[4], bool(r[5]), int(r[6]), float(r[7])) for r in rows
    ]


def _share(part: float, whole: float) -> float | None:
    return round(part / whole, 4) if whole else None


def operator_coverage(catalog: Catalog, routes: list[RouteDay]) -> dict[str, object]:
    by_operator: dict[str, dict[str, float]] = defaultdict(lambda: {"trips": 0, "train_km": 0.0})
    for r in routes:
        entry = by_operator[r.operator_id or ""]
        entry["trips"] += r.trips
        entry["train_km"] += r.train_km
    catalogued = {o.operator_id: o for o in catalog.operators}
    with_qid = {o.operator_id for o in catalog.operators if o.wikidata_qid}
    total_trips = sum(e["trips"] for e in by_operator.values())
    total_km = sum(e["train_km"] for e in by_operator.values())

    def tally(ids: set[str]) -> dict[str, object]:
        trips = sum(e["trips"] for k, e in by_operator.items() if k in ids)
        km = sum(e["train_km"] for k, e in by_operator.items() if k in ids)
        return {
            "operators": len(ids & set(by_operator)),
            "operator_share": _share(len(ids & set(by_operator)), len(by_operator)),
            "trips": trips,
            "trip_share": _share(trips, total_trips),
            "train_km": round(km, 1),
            "train_km_share": _share(km, total_km),
        }

    unmapped = sorted(
        (
            {
                "operator_id": k,
                "trips": int(e["trips"]),
                "train_km": round(e["train_km"], 1),
                "reason": catalogued[k].missing.get("wikidata_qid")
                if k in catalogued
                else "not in the catalogue",
            }
            for k, e in by_operator.items()
            if k not in with_qid
        ),
        key=lambda item: -float(item["train_km"]),
    )
    return {
        "operators_running": len(by_operator),
        "trips": total_trips,
        "train_km": round(total_km, 1),
        "in_catalogue": tally(set(catalogued)),
        "with_wikidata": tally(with_qid),
        "without_wikidata": unmapped,
    }


def series_coverage(catalog: Catalog) -> dict[str, object]:
    result: dict[str, object] = {}
    for priority in ("P1", "P2", "P3", "all"):
        rows = [s for s in catalog.vehicle_series if priority in {"all", s.priority.value}]
        result[priority] = {
            "series": len(rows),
            **{
                f"with_{name}": sum(1 for s in rows if getattr(s, name) is not None)
                for name in SERIES_EXPLAINED_FIELDS
            },
            "with_operators": sum(1 for s in rows if s.operators),
            "with_commons_category": sum(1 for s in rows if s.commons_category),
            "missing_reasons": dict(
                sorted(
                    Counter(
                        name for s in rows for name in s.missing if name in SERIES_EXPLAINED_FIELDS
                    ).items()
                )
            ),
        }
    return result


def line_colour_coverage(catalog: Catalog, routes: list[RouteDay]) -> dict[str, object]:
    by_operator = {(lc.operator_id, line_key(lc.line_name)) for lc in catalog.line_colours}
    by_agency = {(lc.delfi_agency_key, line_key(lc.line_name)) for lc in catalog.line_colours}
    per_category: dict[str, dict[str, float]] = defaultdict(
        lambda: {"routes": 0, "matched_routes": 0, "trips": 0, "matched_trips": 0}
    )
    for r in routes:
        key = line_key(r.short_name)
        matched = bool(key) and (
            (r.operator_id, key) in by_operator or (r.agency_key, key) in by_agency
        )
        for bucket in (per_category[r.category_code], per_category["all"]):
            bucket["routes"] += 1
            bucket["trips"] += r.trips
            if matched:
                bucket["matched_routes"] += 1
                bucket["matched_trips"] += r.trips
    return {
        code: {
            **{k: int(v) for k, v in values.items()},
            "route_share": _share(values["matched_routes"], values["routes"]),
            "trip_share": _share(values["matched_trips"], values["trips"]),
        }
        for code, values in sorted(per_category.items())
    }


def report(
    catalog: Catalog, conn: psycopg.Connection, feed_version: int, day: date
) -> dict[str, object]:
    routes = route_days(conn, feed_version, day)
    return {
        "feed_version_id": feed_version,
        "service_day": day.isoformat(),
        "catalog_sha256": catalog.content_sha256,
        "train_routes_running": len(routes),
        "operators": operator_coverage(catalog, routes),
        "vehicle_series": series_coverage(catalog),
        "line_colours": line_colour_coverage(catalog, routes),
    }
