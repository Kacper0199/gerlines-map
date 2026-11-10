"""Field usage profile of one GTFS-RT payload (gzip or plain).

Usage: python -I profile_feed.py <file>
"""

import gzip
import sys
from collections import Counter
from pathlib import Path

from google.transit import gtfs_realtime_pb2

raw = Path(sys.argv[1]).read_bytes()
if raw[:2] == b"\x1f\x8b":
    raw = gzip.decompress(raw)
feed = gtfs_realtime_pb2.FeedMessage()
feed.ParseFromString(raw)
c: Counter[str] = Counter()
print(
    "header", feed.header.gtfs_realtime_version, feed.header.incrementality, feed.header.timestamp
)
for e in feed.entity:
    c["entity"] += 1
    if e.is_deleted:
        c["deleted"] += 1
    if not e.HasField("trip_update"):
        c["no_tu"] += 1
        continue
    tu = e.trip_update
    t = tu.trip
    c[f"trip_sr={t.schedule_relationship}"] += 1
    c["has_trip_id"] += bool(t.trip_id)
    c["has_route_id"] += bool(t.route_id)
    c["has_start_date"] += bool(t.start_date)
    c["has_start_time"] += bool(t.start_time)
    c["tu_timestamp"] += tu.HasField("timestamp")
    c["tu_delay"] += tu.HasField("delay")
    c["has_vehicle"] += tu.HasField("vehicle")
    n = len(tu.stop_time_update)
    c["stu_0"] += n == 0
    c["stu_total"] += n
    for s in tu.stop_time_update:
        c["stu_seq"] += s.HasField("stop_sequence")
        c["stu_stop_id"] += bool(s.stop_id)
        c[f"stu_sr={s.schedule_relationship}"] += 1
        for name in ("arrival", "departure"):
            if s.HasField(name):
                ev = getattr(s, name)
                c[f"{name}"] += 1
                c[f"{name}.delay"] += ev.HasField("delay")
                c[f"{name}.time"] += ev.HasField("time")
for k, v in sorted(c.items()):
    print(f"{k:28s} {v}")
sample = [
    e for e in feed.entity if e.HasField("trip_update") and len(e.trip_update.stop_time_update) > 2
][:1]
for e in sample:
    print(e)
