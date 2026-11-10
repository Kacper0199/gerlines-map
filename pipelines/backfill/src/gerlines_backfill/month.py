"""Convert one month, one service day at a time, into Parquet folders and a summary."""

import json
from collections import Counter
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

from gerlines_backfill.convert import (
    month_days,
    month_files,
    read_service_day,
    segment_rows,
    stop_rows,
    trip_rows,
)
from gerlines_backfill.summary import comparison_group, punctuality

STOP_COLUMNS = [
    "service_date",
    "trip_key",
    "stop_index",
    "eva",
    "scheduled_arrival",
    "scheduled_departure",
    "final_arrival",
    "final_departure",
    "arrival_delay_s",
    "departure_delay_s",
    "final_quality",
    "cancelled",
    "additional",
    "has_plan_record",
    "trip_start",
]
KINDS = ("stops", "trips", "segments")
BERLIN = ZoneInfo("Europe/Berlin")


def _add(total: dict[str, dict[str, int]], part: dict[str, dict[str, int]]) -> None:
    for key, counts in part.items():
        bucket = total.setdefault(key, {})
        for name, value in counts.items():
            bucket[name] = bucket.get(name, 0) + value


def _source_counts(path: Path, first_day: date) -> tuple[int, int]:
    rows = stop_rows(pl.scan_parquet(path)).select(
        pl.len().alias("rows"), (pl.col("service_date") < first_day).sum().alias("earlier")
    )
    counts = rows.collect().row(0, named=True)
    return int(counts["rows"]), int(counts["earlier"])


def clock_change_days(days: list[date]) -> list[date]:
    def offset(day: date, hour: int) -> timedelta | None:
        return datetime.combine(day, time(hour), BERLIN).utcoffset()

    return [day for day in days if offset(day, 0) != offset(day, 23)]


def _clock_change_rows(stops: pl.DataFrame, changes: list[date]) -> int:
    if not changes:
        return 0
    in_hour = pl.any_horizontal(
        [
            (moment.dt.hour() == 2) & moment.dt.date().is_in(changes)
            for moment in (
                pl.col(name).dt.convert_time_zone("Europe/Berlin")
                for name in ("scheduled_arrival", "scheduled_departure")
            )
        ]
    )
    return int(stops.filter(in_hour).height)


def convert_month(inputs: Path, month: str, out: Path) -> dict[str, object]:
    files = month_files(inputs, month)
    days = month_days(month)
    target = out / month
    for kind in KINDS:
        (target / kind).mkdir(parents=True, exist_ok=True)
    source_rows, earlier = _source_counts(files[0], days[0])
    totals: Counter[str] = Counter()
    categories: dict[str, dict[str, int]] = {}
    groups: dict[str, dict[str, int]] = {}
    by_category: dict[str, dict[str, int]] = {}
    evas: set[int] = set()
    changes = clock_change_days(days)
    for day in days:
        stops = read_service_day(files, day)
        if stops.is_empty():
            continue
        trips = trip_rows(stops)
        segments = segment_rows(stops)
        stops.select(STOP_COLUMNS).write_parquet(target / "stops" / f"{day}.parquet")
        trips.write_parquet(target / "trips" / f"{day}.parquet")
        segments.write_parquet(target / "segments" / f"{day}.parquet")
        totals.update(
            stops=stops.height,
            trips=trips.height,
            segments=segments.height,
            cancelled=int(stops["cancelled"].sum()),
            with_final=int(stops["final_quality"].is_not_null().sum()),
            without_plan_record=int((~stops["has_plan_record"]).sum()),
            additional=int(stops["additional"].sum()),
            clock_change_hour=_clock_change_rows(stops, changes),
        )
        judged = stops.drop("train_type").join(
            trips.select("trip_key", "category_code", "train_type"), on="trip_key"
        )
        _add(categories, punctuality(judged, by="category_code"))
        _add(groups, punctuality(judged.with_columns(comparison_group()), by="group"))
        per_category = trips.group_by("category_code").agg(
            pl.len().alias("trips"), pl.col("stops").sum().alias("stops")
        )
        _add(
            by_category,
            {
                row["category_code"]: {"trips": int(row["trips"]), "stops": int(row["stops"])}
                for row in per_category.iter_rows(named=True)
            },
        )
        evas.update(stops["eva"].unique().to_list())
    stations = _station_names(files, evas)
    summary: dict[str, object] = {
        "month": month,
        "files": [path.name for path in files],
        "next_month_missing": len(files) == 1,
        "converted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_rows": source_rows,
        "source_rows_of_earlier_runs": earlier,
        **{
            name: totals.get(name, 0)
            for name in (
                "stops",
                "trips",
                "segments",
                "cancelled",
                "with_final",
                "without_plan_record",
                "additional",
                "clock_change_hour",
            )
        },
        "by_category": dict(sorted(by_category.items())),
        "punctuality_by_category": categories,
        "punctuality": groups,
        "stations": dict(sorted(stations.items())),
    }
    (target / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    return summary


def _station_names(files: list[Path], evas: set[int]) -> dict[str, str]:
    names = (
        pl.concat([pl.scan_parquet(path).select("eva", "station_name") for path in files])
        .select(pl.col("eva").cast(pl.Int32), "station_name")
        .drop_nulls()
        .group_by("eva")
        .agg(pl.col("station_name").mode().sort().first())
        .collect()
    )
    found = dict(names.iter_rows())
    return {str(eva): found.get(eva, "") for eva in sorted(evas)}
