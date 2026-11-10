"""Reduce GTFS-RT payloads to one row per trip update per tick.

Usage: python -I reduce_rt.py --source ID --manifest CSV --dir DIR --from ISO --to ISO
       [--every-min 5] [--keep-trips PARQUET] --out PARQUET

The manifest has a fetch time column (``fetched_at``, ``requested_utc`` or ``tick_observed_at``,
ISO UTC) and ``file`` (name under DIR, gzip or plain protobuf). For each tick [t, t + every) the
first payload fetched in it is used. ``--keep-trips`` (column ``--keep-column``, default ``trip_id``) limits the rows to
those trips plus every ADDED trip.
"""

import argparse
import csv
import datetime as dt
import gzip
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from google.transit import gtfs_realtime_pb2

STU_TYPE = pa.list_(
    pa.struct(
        [
            ("seq", pa.int64()),
            ("stop_id", pa.string()),
            ("sr", pa.int8()),
            ("arr_delay", pa.int32()),
            ("arr_time", pa.int64()),
            ("dep_delay", pa.int32()),
            ("dep_time", pa.int64()),
        ]
    )
)


def parse_iso(value: str) -> float:
    return dt.datetime.fromisoformat(value).timestamp()


def event(stu, name: str) -> tuple[int | None, int | None]:
    if not stu.HasField(name):
        return None, None
    ev = getattr(stu, name)
    return (ev.delay if ev.HasField("delay") else None, ev.time if ev.HasField("time") else None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--every-min", type=float, default=5.0)
    parser.add_argument("--keep-trips", type=Path)
    parser.add_argument("--keep-column", default="trip_id")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    keep = None
    if args.keep_trips:
        keep = set(
            pq.read_table(args.keep_trips, columns=[args.keep_column])
            .column(args.keep_column)
            .to_pylist()
        )

    with args.manifest.open() as handle:
        entries = sorted(
            (
                parse_iso(
                    row.get("fetched_at") or row.get("requested_utc") or row["tick_observed_at"]
                ),
                row["file"],
            )
            for row in csv.DictReader(handle)
            if row.get("file")
        )
    start, end, step = parse_iso(args.start), parse_iso(args.end), args.every_min * 60
    picks: list[tuple[float, float, str]] = []
    tick = start
    while tick < end:
        chosen = next(((t, f) for t, f in entries if tick <= t < tick + step), None)
        if chosen:
            picks.append((tick, *chosen))
        tick += step

    schema = pa.schema(
        [
            ("source", pa.string()),
            ("tick", pa.int64()),
            ("fetched_at", pa.int64()),
            ("header_ts", pa.int64()),
            ("trip_id", pa.string()),
            ("start_date", pa.string()),
            ("start_time", pa.string()),
            ("route_id", pa.string()),
            ("trip_sr", pa.int8()),
            ("n_stu", pa.int32()),
            ("n_stu_rt", pa.int32()),
            ("stus", STU_TYPE),
        ]
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    writer = pq.ParquetWriter(args.out, schema, compression="zstd")
    names = (
        "source",
        "tick",
        "fetched_at",
        "header_ts",
        "trip_id",
        "start_date",
        "start_time",
        "route_id",
        "trip_sr",
        "n_stu",
        "n_stu_rt",
        "stus",
    )
    payloads = []
    for tick, fetched_at, name in picks:
        cols: dict[str, list] = {c: [] for c in names}
        raw = (args.dir / name).read_bytes()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(raw)
        header_ts = feed.header.timestamp
        n_tu = kept = 0
        for entity in feed.entity:
            if not entity.HasField("trip_update"):
                continue
            n_tu += 1
            tu = entity.trip_update
            trip = tu.trip
            if keep is not None and trip.trip_id not in keep and trip.schedule_relationship != 1:
                continue
            kept += 1
            stus = []
            n_rt = 0
            for stu in tu.stop_time_update:
                ad, at = event(stu, "arrival")
                dd, dt_ = event(stu, "departure")
                if any(v is not None for v in (ad, at, dd, dt_)):
                    n_rt += 1
                stus.append(
                    {
                        "seq": stu.stop_sequence if stu.HasField("stop_sequence") else None,
                        "stop_id": stu.stop_id or None,
                        "sr": stu.schedule_relationship,
                        "arr_delay": ad,
                        "arr_time": at,
                        "dep_delay": dd,
                        "dep_time": dt_,
                    }
                )
            cols["source"].append(args.source)
            cols["tick"].append(int(tick))
            cols["fetched_at"].append(int(fetched_at))
            cols["header_ts"].append(header_ts)
            cols["trip_id"].append(trip.trip_id)
            cols["start_date"].append(trip.start_date)
            cols["start_time"].append(trip.start_time)
            cols["route_id"].append(trip.route_id)
            cols["trip_sr"].append(trip.schedule_relationship)
            cols["n_stu"].append(len(stus))
            cols["n_stu_rt"].append(n_rt)
            cols["stus"].append(stus)
        writer.write_table(pa.table(cols, schema=schema))
        payloads.append(
            {
                "tick": int(tick),
                "fetched_at": int(fetched_at),
                "header_ts": header_ts,
                "file": name,
                "trip_updates": n_tu,
                "kept": kept,
            }
        )
        print(
            f"{args.source} {dt.datetime.fromtimestamp(tick, dt.UTC):%H:%M} tu={n_tu} kept={kept}",
            flush=True,
        )

    writer.close()
    args.out.with_suffix(".payloads.json").write_text(json.dumps(payloads, indent=1))


if __name__ == "__main__":
    main()
