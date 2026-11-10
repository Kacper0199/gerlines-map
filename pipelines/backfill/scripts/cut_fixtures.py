"""Cut the test fixtures from the real monthly files: every row of the listed trips, all columns.

Usage: ``uv run python pipelines/backfill/scripts/cut_fixtures.py <folder>``, the folder holding
``data-YYYY-MM.parquet``.
"""

import sys
from pathlib import Path

import polars as pl

TRIPS = {
    "-7256490561424230809-2511302138": "ICE 1720, crosses from November into December",
    "6477159314363009840-2511120736": "RB 14557, one stop cancelled",
    "8263797658212507001-2511120548": "RB 16370, arrival cancelled at one stop",
    "6919720949608982922-2511120812": "S2 37221, additional stop and cancellations",
    "3169951667936047772-2511120913": "RE 98654, replacement train",
    "-5981311908606748626-2511120711": "Bus SEV 122971, rail replacement bus",
    "-5409632822140594415-2511120831": "HLB RB90 61717, operator brand as train type",
    "8279441909762121432-2511120743": "S1 41563, plain S-Bahn run",
    "3806266644329547244-2603290048": "no train type, runs through the spring clock change",
    "8868050453695511606-2610241920": "NJ, runs through the autumn clock change",
    "6431285891627180853-2610250156": "S, starts in the repeated hour of the autumn clock change",
}
MONTHS = ("2025-11", "2025-12", "2026-03", "2026-10")
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


def main(folder: Path) -> None:
    trip = pl.col("id").str.replace(r"-\d+$", "")
    for month in MONTHS:
        rows = (
            pl.scan_parquet(folder / f"data-{month}.parquet")
            .filter(trip.is_in(list(TRIPS)))
            .sort("id")
            .collect()
        )
        rows.write_parquet(OUT / f"piebro-{month}.parquet", compression="zstd")
        print(f"{month}: {rows.height} rows")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
