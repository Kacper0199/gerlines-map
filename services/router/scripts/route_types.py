"""Count DELFI routes per GTFS route_type, and rail routes per name prefix, for the MOTIS class map.

Usage: route_types.py <delfi-gtfs.zip>
"""

import collections
import csv
import io
import re
import sys
import zipfile

RAIL_TYPES = {"2", "100", "101", "102", "103", "105", "106", "109", "116", "117"}
NAMED = {"ICE", "IC", "EC", "ECE", "NJ", "EN", "FLX", "RJ", "RJX", "TGV", "THA", "S", "RE", "RB"}


def name_prefix(name: str) -> str:
    match = re.match(r"[A-Za-zÄÖÜäöü]+", name)
    if match:
        return match.group(0)
    return "(digits)" if name else "(empty)"


def main(path: str) -> None:
    by_type = collections.Counter()
    by_type_prefix = collections.Counter()
    with zipfile.ZipFile(path) as archive, archive.open("routes.txt") as raw:
        for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")):
            route_type = row["route_type"]
            by_type[route_type] += 1
            if route_type in RAIL_TYPES:
                name = row["route_short_name"].strip() or row["route_long_name"].strip()
                by_type_prefix[route_type, name_prefix(name)] += 1
    print("route_type,routes")
    for route_type, count in by_type.most_common():
        print(f"{route_type},{count}")
    print()
    print("route_type,name_prefix,routes")
    for (route_type, prefix), count in sorted(by_type_prefix.items()):
        if count >= 3 or prefix in NAMED:
            print(f"{route_type},{prefix},{count}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
