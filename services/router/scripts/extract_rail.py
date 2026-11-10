"""Write a rail-only OSM extract for MOTIS route_shapes and platform matching.

Keeps railway tracks (with sidings and yards, so station throats stay connected), platforms,
station and stop nodes, and every node or way these reference. Disused, abandoned, razed and
construction railways are dropped.

Usage: extract_rail.py <input.osm.pbf> <output.osm.pbf>
"""

import sys
import time

import osmium

TRACK_VALUES = {"rail", "light_rail", "subway", "tram", "narrow_gauge", "funicular", "monorail"}
PLATFORM_VALUES = {"platform", "platform_edge"}
STOP_NODE_RAILWAY = {"station", "halt", "stop", "tram_stop", "platform"}
STOP_NODE_PT = {"station", "stop_position", "platform"}


def keep(obj) -> bool:
    tags = obj.tags
    railway = tags.get("railway")
    public_transport = tags.get("public_transport")
    if obj.is_way():
        return (
            railway in TRACK_VALUES or railway in PLATFORM_VALUES or public_transport == "platform"
        )
    if obj.is_node():
        return railway in STOP_NODE_RAILWAY or public_transport in STOP_NODE_PT
    if obj.is_relation():
        is_area = tags.get("type") == "multipolygon"
        return is_area and (railway == "platform" or public_transport == "platform")
    return False


def main(source: str, target: str) -> None:
    started = time.monotonic()
    counts = {"n": 0, "w": 0, "r": 0}
    processor = osmium.FileProcessor(source).with_filter(
        osmium.filter.KeyFilter("railway", "public_transport")
    )
    with osmium.BackReferenceWriter(target, ref_src=source, overwrite=True) as writer:
        for obj in processor:
            if keep(obj):
                writer.add(obj)
                counts[obj.type_str()] += 1
    elapsed = time.monotonic() - started
    print(
        f"kept nodes={counts['n']} ways={counts['w']} relations={counts['r']} seconds={elapsed:.0f}"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
