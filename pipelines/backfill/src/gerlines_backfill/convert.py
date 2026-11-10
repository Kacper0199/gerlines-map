"""piebro monthly rows to our stop events, runs and segments (architecture section 10).

A run is the IRIS trip id without its station number (``<ride>-<YYMMddHHmm>``); its service date
is the date of that start stamp. IRIS times are Berlin wall clock without an offset: planned
times are converted to UTC, and a final time is the planned UTC instant plus the wall-clock delay,
so a delay never jumps by an hour at a clock change. A planned time in the repeated autumn hour is
the earlier instant until the run's wall clock goes back, and the later one from there on.
piebro cuts its months by actual time, so a month's runs are read from its own file and the start
of the next one.
"""

import warnings
from datetime import date, datetime, timedelta
from pathlib import Path

import polars as pl

from gerlines_backfill.categories import classify, line_name

BERLIN = "Europe/Berlin"
FINAL_ONLY = "final_only"
DAY_BEFORE = timedelta(hours=2)
DAY_AFTER = timedelta(days=2)

SOURCE_COLUMNS = [
    "id",
    "eva",
    "station_name",
    "train_type",
    "train_number",
    "line_number",
    "train_line_station_num",
    "arrival_planned_time",
    "arrival_change_time",
    "departure_planned_time",
    "departure_change_time",
    "arrival_is_canceled",
    "departure_is_canceled",
    "is_additional_stop",
    "is_replacement_train",
    "has_plan_record",
    "time",
]


def _utc(expression: pl.Expr, ambiguous: str = "earliest") -> pl.Expr:
    return (
        expression.dt.cast_time_unit("us")
        .dt.replace_time_zone(BERLIN, ambiguous=ambiguous, non_existent="null")
        .dt.convert_time_zone("UTC")
    )


def _seconds(later: pl.Expr, earlier: pl.Expr) -> pl.Expr:
    return (later - earlier).dt.total_seconds().cast(pl.Int32)


def _event(prefix: str) -> dict[str, pl.Expr]:
    planned = pl.col(f"{prefix}_planned_time")
    changed = pl.col(f"{prefix}_change_time")
    present = planned.is_not_null() | changed.is_not_null()
    served = present & ~pl.col(f"{prefix}_is_canceled").fill_null(value=False)
    scheduled = _utc(planned)
    delay = _seconds(changed, planned)
    final = (
        pl.when(served & scheduled.is_not_null() & delay.is_not_null())
        .then(scheduled + pl.duration(seconds=delay))
        .when(served)
        .then(_utc(changed))
    )
    return {
        "present": present,
        "served": served,
        "scheduled": scheduled,
        "final": final,
        "delay": pl.when(served & scheduled.is_not_null()).then(delay),
    }


def stop_rows(frame: pl.LazyFrame) -> pl.LazyFrame:
    """One row per stop of a run with UTC times, cancellation and the run's start."""
    start = (
        pl.col("id").str.extract(r"-(\d{10})-\d+$", 1).str.strptime(pl.Datetime("us"), "%y%m%d%H%M")
    )
    arrival = _event("arrival")
    departure = _event("departure")
    cancelled = (~arrival["present"] | ~arrival["served"]) & (
        ~departure["present"] | ~departure["served"]
    )
    final_arrival = arrival["final"]
    final_departure = departure["final"]
    return frame.select(
        start.dt.date().alias("service_date"),
        pl.col("id").str.replace(r"-\d+$", "").alias("trip_key"),
        (pl.col("train_line_station_num") - 1).cast(pl.Int16).alias("stop_index"),
        pl.col("eva").cast(pl.Int32).alias("eva"),
        pl.col("station_name"),
        pl.col("train_type"),
        pl.col("train_number").str.strip_chars().replace("", None).alias("train_number"),
        pl.col("line_number"),
        arrival["scheduled"].alias("scheduled_arrival"),
        departure["scheduled"].alias("scheduled_departure"),
        final_arrival.alias("final_arrival"),
        final_departure.alias("final_departure"),
        arrival["delay"].alias("arrival_delay_s"),
        departure["delay"].alias("departure_delay_s"),
        pl.when(final_arrival.is_not_null() | final_departure.is_not_null())
        .then(pl.lit(FINAL_ONLY))
        .alias("final_quality"),
        cancelled.alias("cancelled"),
        pl.col("is_additional_stop").fill_null(value=False).alias("additional"),
        pl.col("is_replacement_train").fill_null(value=False).alias("replacement"),
        pl.col("has_plan_record").fill_null(value=False).alias("has_plan_record"),
        _utc(start).alias("trip_start"),
        pl.col("id").alias("piebro_id"),
        pl.col("arrival_planned_time").dt.cast_time_unit("us").alias("arrival_local"),
        pl.col("departure_planned_time").dt.cast_time_unit("us").alias("departure_local"),
    )


def repeated_hour_by_order(stops: pl.DataFrame) -> pl.DataFrame:
    """Move planned times of the repeated autumn hour to the later instant once the run goes back.

    ``stops`` is sorted by run and stop index. The run's wall clock goes back when a planned time
    is earlier than one before it in the run; that time and every ambiguous one after it in the
    run belong to the second pass through the hour.
    """
    arrival, departure = pl.col("arrival_local"), pl.col("departure_local")
    before = pl.max_horizontal(arrival, departure).cum_max().forward_fill().shift(1)
    arrival_back = (arrival < before).fill_null(value=False)
    departure_back = (departure < pl.max_horizontal(arrival, before)).fill_null(value=False)
    went_back = (arrival_back | departure_back).cast(pl.Int8)
    earlier_back = went_back.cum_max().shift(1, fill_value=0) > 0
    marked = stops.with_columns(
        arrival_back.over("trip_key").alias("_arrival_back"),
        departure_back.over("trip_key").alias("_departure_back"),
        earlier_back.over("trip_key").alias("_earlier_back"),
    )
    moved = []
    for prefix in ("arrival", "departure"):
        local = pl.col(f"{prefix}_local")
        shift = _utc(local, "latest") - _utc(local)
        later = (
            (shift > pl.duration(seconds=0))
            & (pl.col(f"_{prefix}_back") | pl.col("_earlier_back") | pl.col("_arrival_back"))
        ).fill_null(value=False)
        moved.extend(
            [
                pl.when(later)
                .then(pl.col(f"scheduled_{prefix}") + shift)
                .otherwise(pl.col(f"scheduled_{prefix}"))
                .alias(f"scheduled_{prefix}"),
                pl.when(later)
                .then(pl.col(f"final_{prefix}") + shift)
                .otherwise(pl.col(f"final_{prefix}"))
                .alias(f"final_{prefix}"),
            ]
        )
    return marked.with_columns(moved).drop(
        "_arrival_back", "_departure_back", "_earlier_back", "arrival_local", "departure_local"
    )


def read_service_day(files: list[Path], day: date) -> pl.DataFrame:
    """Every stop of the runs that start on ``day``, from files sorted by actual time."""
    first = datetime.combine(day, datetime.min.time()) - DAY_BEFORE
    last = datetime.combine(day, datetime.min.time()) + DAY_AFTER
    frames = [
        pl.scan_parquet(path)
        .select(SOURCE_COLUMNS)
        .filter(pl.col("time").is_between(first, last, closed="left"))
        for path in files
    ]
    stops = stop_rows(pl.concat(frames)).filter(pl.col("service_date") == day)
    return repeated_hour_by_order(
        stops.unique(["trip_key", "stop_index"], keep="first")
        .sort(["trip_key", "stop_index"])
        .collect()
    )


def _categories(pairs: pl.DataFrame) -> pl.DataFrame:
    rows = []
    for train_type, line in pairs.iter_rows():
        category, rule = classify(train_type, line)
        rows.append((train_type, line, category, rule, line_name(train_type, line)))
    return pl.DataFrame(
        rows,
        schema={
            "train_type": pl.String,
            "line_number": pl.String,
            "category_code": pl.String,
            "category_rule": pl.String,
            "line_name": pl.String,
        },
        orient="row",
    )


def trip_rows(stops: pl.DataFrame) -> pl.DataFrame:
    """One row per run: number, product, line and category from its stops, origin and start."""
    trips = (
        stops.sort(["trip_key", "stop_index"])
        .group_by(["service_date", "trip_key"], maintain_order=True)
        .agg(
            pl.col("train_type").drop_nulls().first(),
            pl.col("train_number").drop_nulls().first(),
            pl.col("line_number").drop_nulls().first(),
            pl.col("eva").first().alias("origin_eva"),
            pl.col("trip_start").first().alias("origin_departure"),
            pl.col("replacement").any(),
            pl.len().cast(pl.Int32).alias("stops"),
        )
    )
    pairs = trips.select("train_type", "line_number").unique()
    return trips.join(
        _categories(pairs), on=["train_type", "line_number"], how="left", nulls_equal=True
    ).select(
        "service_date",
        "trip_key",
        "train_type",
        "train_number",
        "line_name",
        "category_code",
        "category_rule",
        "origin_eva",
        "origin_departure",
        "replacement",
        "stops",
    )


def segment_rows(stops: pl.DataFrame) -> pl.DataFrame:
    """Legs between consecutive served stops, by the rule of the live fold (services/ingest)."""
    served = stops.filter(
        ~pl.col("cancelled")
        & (pl.col("scheduled_arrival").is_not_null() | pl.col("scheduled_departure").is_not_null())
    ).sort(["trip_key", "stop_index"])
    following = {
        name: pl.col(name).shift(-1).over("trip_key")
        for name in ("stop_index", "eva", "scheduled_arrival", "final_arrival")
    }
    legs = served.with_columns(
        following["stop_index"].alias("to_index"),
        following["eva"].alias("to_eva"),
        following["scheduled_arrival"].alias("to_scheduled_arrival"),
        following["final_arrival"].alias("to_final_arrival"),
    ).filter(
        pl.col("to_index").is_not_null()
        & pl.col("final_departure").is_not_null()
        & pl.col("scheduled_departure").is_not_null()
        & pl.col("to_final_arrival").is_not_null()
        & pl.col("to_scheduled_arrival").is_not_null()
    )
    dep_delay = _seconds(pl.col("final_departure"), pl.col("scheduled_departure"))
    arr_delay = _seconds(pl.col("to_final_arrival"), pl.col("to_scheduled_arrival"))
    dwell = pl.when(
        pl.col("final_arrival").is_not_null() & pl.col("scheduled_arrival").is_not_null()
    ).then(
        _seconds(pl.col("final_departure"), pl.col("final_arrival"))
        - _seconds(pl.col("scheduled_departure"), pl.col("scheduled_arrival"))
    )
    return legs.select(
        "service_date",
        "trip_key",
        pl.col("stop_index").alias("from_index"),
        pl.col("to_index"),
        pl.col("eva").alias("from_eva"),
        "to_eva",
        dep_delay.alias("dep_delay_from_s"),
        arr_delay.alias("arr_delay_to_s"),
        (arr_delay - dep_delay).alias("delay_gain_s"),
        _seconds(pl.col("to_scheduled_arrival"), pl.col("scheduled_departure")).alias(
            "run_sched_s"
        ),
        _seconds(pl.col("to_final_arrival"), pl.col("final_departure")).alias("run_act_s"),
        dwell.cast(pl.Int32).alias("dwell_delay_s"),
        pl.col("to_final_arrival").alias("observed_at"),
    )


def next_month(month: str) -> str:
    year, number = (int(part) for part in month.split("-"))
    return f"{year + 1:04d}-01" if number == 12 else f"{year:04d}-{number + 1:02d}"


def month_files(folder: Path, month: str) -> list[Path]:
    """The month's file and the next one; without the next, runs of the last day lose late stops."""
    files = [folder / f"data-{month}.parquet"]
    following = folder / f"data-{next_month(month)}.parquet"
    if following.is_file():
        files.append(following)
    else:
        warnings.warn(
            f"{following.name} is missing: runs of the last day of {month} lose the stops"
            " they make after midnight",
            UserWarning,
            stacklevel=2,
        )
    return files


def month_days(month: str) -> list[date]:
    first = date.fromisoformat(f"{month}-01")
    end = date.fromisoformat(f"{next_month(month)}-01")
    return [first + timedelta(days=offset) for offset in range((end - first).days)]
