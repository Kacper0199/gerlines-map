"""Command line: ``gerlines-predict <command>``; see pipelines/predict/README.md."""

import argparse
import json
import sys
import time
from pathlib import Path

from gerlines_predict import shadow
from gerlines_predict.backtest import Options, month_files, run_backtest
from gerlines_predict.pairs import MAX_AHEAD
from gerlines_predict.quantiles import MIN_RUNS, VARIANTS
from gerlines_predict.report import (
    chosen_variant,
    decide,
    markdown_decision,
    markdown_table,
    overall_mae,
    shipped_ahead,
    summarise,
)
from gerlines_predict.table import build_table, write_table


def months_between(first: str, last: str) -> list[str]:
    year, month = map(int, first.split("-"))
    end = tuple(map(int, last.split("-")))
    months = []
    while (year, month) <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gerlines-predict", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    backtest = commands.add_parser("backtest", help="zero, B0 and B1 on a strict time split")
    backtest.add_argument("--converted", type=Path, required=True, help="data/backfill/piebro")
    backtest.add_argument("--first", required=True, help="first month, YYYY-MM")
    backtest.add_argument("--last", required=True, help="last month, YYYY-MM")
    backtest.add_argument("--window", type=int, default=3, help="training months before each test")
    backtest.add_argument("--min-runs", type=int, default=MIN_RUNS, help="runs a level needs")
    backtest.add_argument("--max-ahead", type=int, default=MAX_AHEAD)
    backtest.add_argument("--shards", type=int, default=1, help="train-level passes (memory)")
    backtest.add_argument("--test", nargs="*", help="test months (default: all after the window)")
    backtest.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    backtest.add_argument("--out", type=Path, required=True, help="folder for metrics and report")

    table = commands.add_parser("table", help="the served B1 quantile table")
    table.add_argument("--converted", type=Path, required=True, help="data/backfill/piebro")
    table.add_argument("--first", required=True, help="first training month, YYYY-MM")
    table.add_argument("--last", required=True, help="last training month, YYYY-MM")
    table.add_argument("--report", type=Path, required=True, help="backtest.json of the backtest")
    table.add_argument("--min-runs", type=int, default=MIN_RUNS, help="runs a level needs")
    table.add_argument("--shards", type=int, default=1, help="train-level passes (memory)")
    table.add_argument("--out", type=Path, required=True, help="the table file (.json.gz)")

    shadow = commands.add_parser("shadow", help="B1, B0 and the feed against live finals")
    shadow.add_argument("--details", type=Path, required=True, help="shadow_details.ts output")
    shadow.add_argument("--finals", type=Path, required=True, help="stop_event finals (CSV)")
    shadow.add_argument("--table", type=Path, required=True, help="the served table (.json.gz)")
    shadow.add_argument("--converted", type=Path, help="data/backfill/piebro, for the mapping")
    shadow.add_argument("--months", nargs="*", default=[], help="training months, YYYY-MM")
    shadow.add_argument("--out", type=Path, required=True, help="the report (.json)")
    return parser


def backtest_command(args: argparse.Namespace) -> int:
    started = time.monotonic()
    months = months_between(args.first, args.last)
    args.out.mkdir(parents=True, exist_ok=True)

    def log(line: str) -> None:
        print(f"[{time.monotonic() - started:7.1f} s] {line}", file=sys.stderr, flush=True)

    options = Options(
        window=args.window,
        test_months=args.test,
        variants=args.variants,
        min_runs=args.min_runs,
        max_ahead=args.max_ahead,
        shards=args.shards,
    )
    metrics = run_backtest(args.converted, months, options, log=log)
    metrics.write_parquet(args.out / "metrics.parquet")
    variant = chosen_variant(metrics)
    decision = decide(metrics, variant)
    tables = {by: summarise(metrics, by) for by in ("ahead_bin", "minutes_label", "band_label")}
    report = {
        "months": months,
        "window": args.window,
        "min_runs": args.min_runs,
        "max_ahead": args.max_ahead,
        "variants": args.variants,
        "shards": args.shards,
        "test_months": sorted(metrics["test_month"].unique().to_list()),
        "overall_mae": overall_mae(metrics),
        "variant": variant,
        "shipped_ahead": shipped_ahead(decision),
        "decision": decision.to_dicts(),
        "tables": {by: frame.to_dicts() for by, frame in tables.items()},
    }
    (args.out / "backtest.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
    text = [
        f"B1 variant: {variant}; overall MAE {json.dumps(report['overall_mae'])}",
        "",
        markdown_table(tables["ahead_bin"], variant, "stops ahead"),
        "",
        markdown_table(tables["minutes_label"], variant, "minutes ahead"),
        "",
        markdown_table(tables["band_label"], variant, "current delay"),
        "",
        markdown_decision(decision),
    ]
    (args.out / "backtest.md").write_text("\n".join(text) + "\n")
    print("\n".join(text))
    log("done")
    return 0


def table_command(args: argparse.Namespace) -> int:
    report = json.loads(args.report.read_text())
    table = build_table(
        [month_files(args.converted, month) for month in months_between(args.first, args.last)],
        report["variant"],
        report["shipped_ahead"],
        args.min_runs,
        args.shards,
    )
    size = write_table(table, args.out)
    print(json.dumps({"out": str(args.out), "bytes": size, **table["meta"]["counts"]}))
    return 0


def shadow_command(args: argparse.Namespace) -> int:
    trip_files = (
        [
            path
            for month in args.months
            for path in sorted((args.converted / month / "trips").glob("*.parquet"))
        ]
        if args.converted
        else []
    )
    report = shadow.run(args.details, args.finals, args.table, trip_files)
    args.out.write_text(json.dumps(report, indent=2, default=str) + "\n")
    print(json.dumps({key: report[key] for key in ("scored_pairs", "common_pairs", "trips")}))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "backtest":
        return backtest_command(args)
    if args.command == "shadow":
        return shadow_command(args)
    return table_command(args)


if __name__ == "__main__":
    sys.exit(main())
