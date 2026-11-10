"""Reduce the IRIS sampler output to plan stops and fchg observations.

Usage: python -I iris_reduce.py <iris-dir> <out-dir>
Writes ``iris_plan.parquet`` (one row per station and IRIS stop id, from every plan payload) and
``iris_fchg.parquet`` (one row per fchg payload and stop id it names).
"""

import csv
import datetime as dt
import gzip
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq
from defusedxml.ElementTree import fromstring

BERLIN = ZoneInfo("Europe/Berlin")


def iris_time(value: str | None) -> int | None:
    if not value:
        return None
    local = dt.datetime.strptime(value, "%y%m%d%H%M").replace(tzinfo=BERLIN)
    return int(local.timestamp())


def compact_utc(value: str) -> int:
    return int(dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.UTC).timestamp())


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    with (src / "request-log.csv").open() as handle:
        log = [row for row in csv.DictReader(handle) if row["http_code"] == "200" and row["file"]]

    plan: dict[tuple[int, str], dict] = {}
    fchg: dict[str, list] = {
        c: []
        for c in (
            "fetched_at",
            "eva",
            "stop_id",
            "ar_ct",
            "dp_ct",
            "ar_cs",
            "dp_cs",
            "n_messages",
            "latest_msg_ts",
        )
    }
    for row in log:
        root = fromstring(gzip.decompress((src / "payloads" / row["file"]).read_bytes()))
        eva = int(row["eva"])
        fetched = compact_utc(row["requested_utc"])
        for s in root.iter("s"):
            sid = s.get("id", "")
            ar, dp, tl = s.find("ar"), s.find("dp"), s.find("tl")
            if row["endpoint"] == "plan":
                plan[(eva, sid)] = {
                    "eva": eva,
                    "stop_id": sid,
                    "trip_key": sid.rsplit("-", 1)[0],
                    "c": tl.get("c") if tl is not None else None,
                    "n": tl.get("n") if tl is not None else None,
                    "f": tl.get("f") if tl is not None else None,
                    "o": tl.get("o") if tl is not None else None,
                    "line": (dp if dp is not None else ar).get("l")
                    if (dp is not None or ar is not None)
                    else None,
                    "ar_pt": iris_time(ar.get("pt")) if ar is not None else None,
                    "dp_pt": iris_time(dp.get("pt")) if dp is not None else None,
                    "ar_ppth": ar.get("ppth") if ar is not None else None,
                    "dp_ppth": dp.get("ppth") if dp is not None else None,
                }
                continue
            stamps = [m.get("ts") for m in s.iter("m") if m.get("ts")]
            fchg["fetched_at"].append(fetched)
            fchg["eva"].append(eva)
            fchg["stop_id"].append(sid)
            fchg["ar_ct"].append(iris_time(ar.get("ct")) if ar is not None else None)
            fchg["dp_ct"].append(iris_time(dp.get("ct")) if dp is not None else None)
            fchg["ar_cs"].append(ar.get("cs") if ar is not None else None)
            fchg["dp_cs"].append(dp.get("cs") if dp is not None else None)
            fchg["n_messages"].append(len(stamps))
            fchg["latest_msg_ts"].append(max((iris_time(t) for t in stamps), default=None))

    pq.write_table(pa.Table.from_pylist(list(plan.values())), out / "iris_plan.parquet")
    pq.write_table(pa.table(fchg), out / "iris_fchg.parquet")
    print(f"plan stops {len(plan)}, fchg rows {len(fchg['stop_id'])}, payloads {len(log)}")


if __name__ == "__main__":
    main()
