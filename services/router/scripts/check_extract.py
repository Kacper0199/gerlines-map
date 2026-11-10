"""Check an OSM extract for referential completeness and count railway way types.

Usage: check_extract.py <extract.osm.pbf>
"""

import collections
import sys

import osmium


def main(path: str) -> None:
    node_ids = osmium.index.IdSet()
    counts = collections.Counter()
    railway_ways = collections.Counter()
    missing = 0
    for obj in osmium.FileProcessor(path):
        if obj.is_node():
            node_ids.set(obj.id)
            counts["nodes"] += 1
        elif obj.is_way():
            counts["ways"] += 1
            railway_ways[obj.tags.get("railway", obj.tags.get("public_transport", "-"))] += 1
            missing += sum(1 for ref in obj.nodes if not node_ids.get(ref.ref))
        else:
            counts["relations"] += 1
    print(
        " ".join(f"{key}={value}" for key, value in counts.items()),
        f"missing_way_node_refs={missing}",
    )
    print("way_tag_value,ways")
    for value, count in railway_ways.most_common(15):
        print(f"{value},{count}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
