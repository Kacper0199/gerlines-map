"""Monthly punctuality of converted months under the comparison's counting variants (G7).

Every variant starts from the comparable scope of `comparable.py` (Fernverkehr ICE, IC and EC,
Nahverkehr regional rail with a DB Regio number, stations inside Germany) and the rollups' rule
(< 360 s, arrivals at stops after the first). Variants:

- `base`: the comparable figure.
- `no_partly_cancelled_runs`: runs with any cancelled stop leave the base entirely (DB AG in
  Drucksache 19/1999: partly or wholly cancelled trains are taken out of the population).
- `planned_stops`: stops with a plan record and not additional.
- `no_partly_cancelled_planned`: both of the above.
- `no_replacement`: without replacement trains.
- `final_stops` and `intermediate_stops`: the last observed arrival of a run, the others.
- `per_run`: mean over runs of each run's share of punctual arrivals.
- `per_km`: arrivals weighted by the great-circle distance from the previous observed stop.
- `operator_db_fv`, `operator_cooperation`, `operator_foreign`: Fernverkehr runs by the IRIS
  operator codes Bahn-Vorhersage gives their train number (`--bv-days`, daily files of its 2025
  archive): only 80 (DB Fernverkehr), 80 and others, none of 80; each also without partly
  cancelled runs.
- `db_method`: the population of DB's figures (`gerlines_backfill.comparison`): DB-operated
  Fernverkehr or DB Regio Nahverkehr, without partly cancelled runs;
  `db_method_with_unknown_operator` also counts Fernverkehr numbers Bahn-Vorhersage does not have.
- Fernverkehr product scopes `fv_ice`, `fv_ice_ic_ec_ece`, `fv_with_rj_tgv`, `fv_with_nj`,
  `fv_with_flx`.

    uv run python pipelines/backfill/scripts/g7_variants.py --converted data/backfill/piebro \
        --delfi data/static/2026-10-19/delfi-gtfs-trains.zip \
        --stations data/inputs/bahn-vorhersage/2026-10-28/stations.parquet \
        --outline apps/web/public/geo/germany-outline.geojson \
        --bv-days <2025-11-12.parquet 2025-11-15.parquet 2025-11-16.parquet 2025-12-17.parquet from
        2025.tar> --first 2025-11 --last 2026-10
"""

import argparse
import json
import sys
from pathlib import Path

import polars as pl
from comparable import abroad_evas, operator_of_numbers

from gerlines_backfill.comparison import (
    db_method_scope,
    fv_operator_of_numbers,
    runs_with_cancelled_stop,
)
from gerlines_backfill.download import months_between
from gerlines_backfill.summary import NAHVERKEHR_CATEGORIES, PUNCTUAL_S, stop_delay

PRODUCTS = {
    "fv": ("ICE", "IC", "EC"),
    "fv_ice": ("ICE",),
    "fv_ice_ic_ec_ece": ("ICE", "IC", "EC", "ECE"),
    "fv_with_rj_tgv": ("ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV"),
    "fv_with_nj": ("ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV", "NJ", "EN"),
    "fv_with_flx": ("ICE", "IC", "EC", "ECE", "RJ", "RJX", "TGV", "NJ", "EN", "FLX"),
}
EARTH_KM = 6371.0088


def fv_operators_from_days(days: list[Path]) -> pl.DataFrame:
    return fv_operator_of_numbers(
        pl.concat(
            [pl.read_parquet(day, columns=["operator", "category", "number"]) for day in days]
        )
    )


def leg_km() -> pl.Expr:
    lat1, lon1 = pl.col("prev_lat").radians(), pl.col("prev_lon").radians()
    lat2, lon2 = pl.col("lat").radians(), pl.col("lon").radians()
    a = ((lat2 - lat1) / 2).sin() ** 2 + lat1.cos() * lat2.cos() * ((lon2 - lon1) / 2).sin() ** 2
    return (2 * EARTH_KM * a.sqrt().arcsin()).alias("leg_km")


def day_arrivals(
    stops: pl.DataFrame,
    trips: pl.DataFrame,
    numbers: pl.DataFrame,
    fv_operators: pl.DataFrame,
    coords: pl.DataFrame,
) -> pl.DataFrame:
    trips = (
        trips.with_columns(pl.col("train_number").str.extract(r"^0*(\d+)$", 1).alias("number"))
        .join(numbers, on="number", how="left")
        .join(fv_operators, on="number", how="left")
    )
    partly = runs_with_cancelled_stop(stops)
    observed = (
        stops.with_columns(stop_delay())
        .filter(pl.col("stop_delay_s").is_not_null())
        .sort("trip_key", "stop_index")
        .join(coords, on="eva", how="left")
        .with_columns(
            pl.col("lat").shift(1).over("trip_key").alias("prev_lat"),
            pl.col("lon").shift(1).over("trip_key").alias("prev_lon"),
            (pl.col("stop_index") == pl.col("stop_index").max().over("trip_key")).alias("last"),
        )
        .with_columns(leg_km())
    )
    return (
        observed.filter(pl.col("stop_index") > 0)
        .join(trips, on="trip_key")
        .join(partly, on="trip_key")
        .with_columns((pl.col("stop_delay_s") < PUNCTUAL_S).alias("punctual"))
    )


def scopes(frame: pl.DataFrame, abroad: list[int]) -> dict[str, pl.DataFrame]:
    domestic = frame.filter(~pl.col("eva").is_in(abroad))
    method = frame.with_columns(db_method_scope(abroad))
    fv = domestic.filter(pl.col("train_type").is_in(PRODUCTS["fv"]))
    nv = domestic.filter(
        pl.col("category_code").is_in(NAHVERKEHR_CATEGORIES)
        & (pl.col("operator_group") == "db_regio")
    )
    out: dict[str, pl.DataFrame] = {}
    for group, base in (("fv", fv), ("nv", nv)):
        out[f"{group}.base"] = base
        out[f"{group}.no_partly_cancelled_runs"] = base.filter(~pl.col("run_has_cancelled"))
        out[f"{group}.planned_stops"] = base.filter(
            pl.col("has_plan_record") & ~pl.col("additional")
        )
        out[f"{group}.no_replacement"] = base.filter(~pl.col("replacement"))
        out[f"{group}.no_partly_cancelled_planned"] = base.filter(
            ~pl.col("run_has_cancelled") & pl.col("has_plan_record") & ~pl.col("additional")
        )
        out[f"{group}.final_stops"] = base.filter(pl.col("last"))
        out[f"{group}.intermediate_stops"] = base.filter(~pl.col("last"))
    for operator in ("db_fv", "cooperation", "foreign"):
        own = fv.filter(pl.col("fv_operator") == operator)
        out[f"fv.operator_{operator}"] = own
        out[f"fv.operator_{operator}_no_partly_cancelled"] = own.filter(
            ~pl.col("run_has_cancelled")
        )
    out["fv.operator_unknown"] = fv.filter(pl.col("fv_operator").is_null())
    out["fv.db_method"] = method.filter(pl.col("db_scope") == "fernverkehr")
    out["fv.db_method_with_unknown_operator"] = fv.filter(
        ~pl.col("run_has_cancelled")
        & (pl.col("fv_operator").is_null() | (pl.col("fv_operator") == "db_fv"))
    )
    out["nv.db_method"] = method.filter(pl.col("db_scope") == "nahverkehr")
    for name, products in PRODUCTS.items():
        if name != "fv":
            out[f"fv.{name}"] = domestic.filter(pl.col("train_type").is_in(products))
    return out


def tally(frame: pl.DataFrame) -> dict[str, float]:
    per_run = frame.group_by("trip_key").agg(pl.col("punctual").mean().alias("share"))
    weighted = frame.drop_nulls("leg_km")
    return {
        "arrivals": frame.height,
        "punctual": int(frame["punctual"].sum()),
        "runs": per_run.height,
        "run_share_sum": float(per_run["share"].sum()),
        "km": float(weighted["leg_km"].sum()),
        "km_punctual": float(weighted.filter(pl.col("punctual"))["leg_km"].sum()),
    }


def month_variants(
    folder: Path,
    numbers: pl.DataFrame,
    fv_operators: pl.DataFrame,
    abroad: list[int],
    coords: pl.DataFrame,
) -> dict[str, float]:
    totals: dict[str, dict[str, float]] = {}
    for path in sorted((folder / "stops").glob("*.parquet")):
        arrivals = day_arrivals(
            pl.read_parquet(path),
            pl.read_parquet(
                folder / "trips" / path.name,
                columns=["trip_key", "train_type", "train_number", "category_code", "replacement"],
            ),
            numbers,
            fv_operators,
            coords,
        )
        for name, frame in scopes(arrivals, abroad).items():
            bucket = totals.setdefault(name, {})
            for key, value in tally(frame).items():
                bucket[key] = bucket.get(key, 0) + value
    figures: dict[str, float] = {}
    for name, t in sorted(totals.items()):
        if not t["arrivals"]:
            continue
        figures[name] = round(100 * t["punctual"] / t["arrivals"], 2)
        if name.endswith(".base"):
            group = name.split(".")[0]
            figures[f"{group}.per_run"] = round(100 * t["run_share_sum"] / t["runs"], 2)
            figures[f"{group}.per_km"] = round(100 * t["km_punctual"] / t["km"], 2)
            figures[f"{group}.arrivals"] = int(t["arrivals"])
            figures[f"{group}.runs"] = int(t["runs"])
        if ".operator_" in name or name.endswith((".no_partly_cancelled_runs", ".db_method")):
            figures[f"{name}.arrivals"] = int(t["arrivals"])
            figures[f"{name}.runs"] = int(t["runs"])
    return figures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--converted", type=Path, required=True)
    parser.add_argument("--delfi", type=Path, required=True)
    parser.add_argument("--stations", type=Path, required=True)
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument("--bv-days", type=Path, nargs="+", required=True)
    parser.add_argument("--first", required=True)
    parser.add_argument("--last", required=True)
    args = parser.parse_args()
    numbers = operator_of_numbers(args.delfi)
    fv_operators = fv_operators_from_days(args.bv_days)
    abroad, _ = abroad_evas(args.stations, args.outline)
    coords = (
        pl.read_parquet(args.stations, columns=["eva", "lat", "lon"])
        .drop_nulls()
        .unique("eva")
        .with_columns(pl.col("eva").cast(pl.Int32))
    )
    for month in months_between(args.first, args.last):
        figures = month_variants(
            args.converted / month, numbers, fv_operators, sorted(abroad), coords
        )
        print(json.dumps({"month": month, **figures}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
