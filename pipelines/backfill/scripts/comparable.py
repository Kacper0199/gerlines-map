"""Monthly punctuality of converted months on DB's scope and on ours (G7, docs/history.md).

Comparable scope: Fernverkehr is the DB Fernverkehr products ICE, IC and EC; Nahverkehr the
regional rail runs (rfast, reg, sbahn) whose train number the DELFI trains feed gives to DB Regio
companies only (DB Regio, DB RegioNetz, S-Bahn Berlin, S-Bahn Hamburg). Both leave out stations
located outside the Germany outline. Full scope: the summary's groups (Fernverkehr ICE, IC, EC,
ECE, RJ, RJX, TGV, Nahverkehr every regional operator). The rule is the rollups' one
(summary.stop_delay, < 360 s).

    uv run python pipelines/backfill/scripts/comparable.py --converted data/backfill/piebro \
        --delfi data/static/2026-10-19/delfi-gtfs-trains.zip \
        --stations data/inputs/bahn-vorhersage/2026-10-28/stations.parquet \
        --outline apps/web/public/geo/germany-outline.geojson --first 2025-11 --last 2026-10
"""

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import polars as pl
import shapely
from shapely.geometry import shape

from gerlines_backfill.download import months_between
from gerlines_backfill.summary import NAHVERKEHR_CATEGORIES, PUNCTUAL_S, stop_delay

COMPARABLE_FV = ("ICE", "IC", "EC")
DB_REGIO = r"^(DB Regio|DB RegioNetz|DB-Nahverkehr|DB-Zug|S-Bahn Berlin|S-Bahn Hamburg|SÜWEX)"
STOP_COLUMNS = [
    "trip_key",
    "stop_index",
    "eva",
    "scheduled_arrival",
    "scheduled_departure",
    "final_arrival",
    "final_departure",
    "cancelled",
]


def _table(archive: zipfile.ZipFile, name: str, columns: list[str]) -> pl.DataFrame:
    return pl.read_csv(io.BytesIO(archive.read(name)), columns=columns, infer_schema=False)


def operator_of_numbers(delfi: Path) -> pl.DataFrame:
    """Train number to db_regio, other or mixed, from the agencies of its trips in the feed."""
    with zipfile.ZipFile(delfi) as archive:
        agency = _table(archive, "agency.txt", ["agency_id", "agency_name"])
        routes = _table(archive, "routes.txt", ["route_id", "agency_id"])
        trips = _table(archive, "trips.txt", ["route_id", "trip_short_name"])
    named = (
        trips.join(routes, on="route_id")
        .join(agency, on="agency_id")
        .with_columns(
            pl.col("trip_short_name").str.extract(r"^\s*0*(\d+)\s*$", 1).alias("number"),
            pl.col("agency_name").str.contains(DB_REGIO).alias("db_regio"),
        )
        .drop_nulls("number")
    )
    return named.group_by("number").agg(
        pl.when(pl.col("db_regio").all())
        .then(pl.lit("db_regio"))
        .when(~pl.col("db_regio").any())
        .then(pl.lit("other"))
        .otherwise(pl.lit("mixed"))
        .first()
        .alias("operator_group")
    )


def abroad_evas(stations: Path, outline: Path) -> tuple[set[int], set[int]]:
    """EVA numbers located outside the Germany outline, and those without coordinates."""
    frame = pl.read_parquet(stations, columns=["eva", "lat", "lon"])
    feature = json.loads(outline.read_text())
    geometries = [shape(f["geometry"]) for f in feature.get("features", [feature])]
    germany = shapely.union_all(geometries)
    located = frame.drop_nulls(["lat", "lon"])
    inside = shapely.contains_xy(germany, located["lon"].to_numpy(), located["lat"].to_numpy())
    return set(located.filter(~pl.Series(inside))["eva"].to_list()), set(
        frame.filter(pl.col("lat").is_null())["eva"].to_list()
    )


def _counts(frame: pl.DataFrame, group: str) -> pl.DataFrame:
    return frame.group_by(group).agg(
        pl.len().alias("arrivals"),
        (pl.col("stop_delay_s") < PUNCTUAL_S).sum().alias("punctual"),
        pl.col("trip_key").n_unique().alias("runs"),
    )


def month_figures(
    folder: Path, numbers: pl.DataFrame, abroad: set[int]
) -> dict[str, dict[str, float | int]]:
    totals: dict[str, dict[str, int]] = {}
    for path in sorted((folder / "stops").glob("*.parquet")):
        stops = pl.read_parquet(path, columns=STOP_COLUMNS)
        trips = pl.read_parquet(
            folder / "trips" / path.name,
            columns=["trip_key", "train_type", "train_number", "category_code"],
        ).with_columns(pl.col("train_number").str.extract(r"^0*(\d+)$", 1).alias("number"))
        trips = trips.join(numbers, on="number", how="left")
        arrivals = (
            stops.with_columns(stop_delay())
            .filter((pl.col("stop_index") > 0) & pl.col("stop_delay_s").is_not_null())
            .join(trips, on="trip_key")
            .with_columns((~pl.col("eva").is_in(list(abroad))).alias("domestic"))
        )
        nv = pl.col("category_code").is_in(NAHVERKEHR_CATEGORIES)
        labelled = arrivals.with_columns(
            pl.when(pl.col("train_type").is_in(COMPARABLE_FV) & pl.col("domestic"))
            .then(pl.lit("fv_comparable"))
            .when(nv & (pl.col("operator_group") == "db_regio") & pl.col("domestic"))
            .then(pl.lit("nv_comparable"))
            .when(nv & (pl.col("operator_group") == "other"))
            .then(pl.lit("nv_other_operator"))
            .when(nv & (pl.col("operator_group") == "mixed"))
            .then(pl.lit("nv_mixed_number"))
            .when(nv & pl.col("operator_group").is_null())
            .then(pl.lit("nv_number_not_in_feed"))
            .when(nv)
            .then(pl.lit("nv_db_regio_abroad"))
            .otherwise(pl.lit("rest"))
            .alias("scope")
        )
        for row in _counts(labelled, "scope").iter_rows(named=True):
            bucket = totals.setdefault(row["scope"], {"arrivals": 0, "punctual": 0, "runs": 0})
            for key in ("arrivals", "punctual", "runs"):
                bucket[key] += int(row[key])
    return {
        scope: {**counts, "share": round(100 * counts["punctual"] / counts["arrivals"], 2)}
        for scope, counts in sorted(totals.items())
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--converted", type=Path, required=True)
    parser.add_argument("--delfi", type=Path, required=True)
    parser.add_argument("--stations", type=Path, required=True)
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument("--first", required=True)
    parser.add_argument("--last", required=True)
    args = parser.parse_args()
    numbers = operator_of_numbers(args.delfi)
    abroad, unlocated = abroad_evas(args.stations, args.outline)
    print(
        json.dumps(
            {
                "numbers": dict(numbers.group_by("operator_group").len().iter_rows()),
                "evas_abroad": len(abroad),
                "evas_without_coordinates": len(unlocated),
            }
        ),
        flush=True,
    )
    for month in months_between(args.first, args.last):
        folder = args.converted / month
        summary = json.loads((folder / "summary.json").read_text())
        full = {
            group: round(100 * c["lt_6min"] / c["arrivals"], 2)
            for group, c in summary["punctuality"].items()
        }
        figures = month_figures(folder, numbers, abroad)
        print(json.dumps({"month": month, "full": full, "scopes": figures}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
