import json
from pathlib import Path

import osmium
import pytest
import shapely
from osmium.osm.mutable import Node, Relation, Way

from gerlines_rail_graph.index import load_coverage
from gerlines_rail_graph.neighbours import (
    FILTER_VERSION,
    area_km2,
    clip_to_corridor,
    corridor,
    filter_rail,
    held_area,
    merge_osm,
    read_polygon,
    sha256_of,
)
from gerlines_rail_graph.osm import route_kinds_by_way_in
from gerlines_rail_graph.patterns import Pattern
from gerlines_rail_graph.project import to_xy

GERMANY = [[8.0, 49.0], [10.0, 49.0], [10.0, 51.0], [8.0, 51.0], [8.0, 49.0]]
ABROAD = [[10.0, 49.0], [11.0, 49.0], [11.0, 51.0], [10.0, 51.0], [10.0, 49.0]]


def write_polygon(path: Path, ring: list) -> Path:
    feature = {
        "type": "Feature",
        "properties": {},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [feature]}))
    return path


def point(lon: float, lat: float) -> shapely.Point:
    return shapely.Point(*to_xy([lon], [lat])[0])


def test_coverage_without_extra_is_the_inset_outline(tmp_path):
    cover = load_coverage(write_polygon(tmp_path / "de.geojson", GERMANY))

    assert cover.contains(point(9.0, 50.0))
    assert not cover.contains(point(9.99, 50.0))
    assert not cover.contains(point(10.5, 50.0))


def test_extra_coverage_joins_the_outline_before_the_inset(tmp_path):
    cover = load_coverage(
        write_polygon(tmp_path / "de.geojson", GERMANY),
        extra=write_polygon(tmp_path / "corridor.geojson", ABROAD),
    )

    assert cover.contains(point(9.99, 50.0))
    assert cover.contains(point(10.01, 50.0))
    assert cover.contains(point(10.5, 50.0))
    assert not cover.contains(point(10.99, 50.0))


def pattern(stops: list[tuple[float, float]], pattern_id: str = "p1") -> Pattern:
    return Pattern(
        pattern_id=pattern_id,
        route_key="r",
        route_short_name="RE1",
        category="reg",
        direction_id=0,
        stops=[(f"s{i}", f"Stop {i}", lon, lat) for i, (lon, lat) in enumerate(stops)],
        rep_trip="t",
        rep_date="2026-11-02",
        rep_departure_s=0,
        trips=1,
        trip_days_week=1,
        length_km=1.0,
        scope="cross_border",
    )


def test_corridor_buffers_the_legs_abroad_by_a_share_of_their_length(tmp_path):
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    leg = pattern([(9.5, 50.0), (10.5, 50.0)])

    area = corridor([leg], outline, cap_km=300, share=0.2, min_km=5, max_km=25)

    assert area.contains(shapely.Point(10.5, 50.0))
    assert area.contains(shapely.Point(10.5, 50.08))
    assert not area.contains(shapely.Point(10.5, 50.2))


def test_corridor_keeps_legs_inside_germany_out_and_stops_at_the_cap(tmp_path):
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    domestic = pattern([(8.5, 50.0), (9.5, 50.0)], "home")
    far = pattern([(9.9, 50.0), (14.0, 50.0)], "far")

    area = corridor([domestic, far], outline, cap_km=100, share=0.2, min_km=5, max_km=25)

    assert not area.contains(shapely.Point(9.0, 50.0))
    assert area.contains(shapely.Point(10.8, 50.0))
    assert not area.contains(shapely.Point(12.0, 50.0))


def test_corridor_holds_a_leg_that_leaves_and_comes_back_and_a_leg_wholly_abroad(tmp_path):
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    hook = pattern([(9.9, 49.2), (10.3, 49.5), (9.9, 49.8)], "hook")
    abroad = pattern([(10.4, 50.6), (10.8, 50.6)], "abroad")

    area = corridor([hook, abroad], outline, cap_km=300, share=0.2, min_km=5, max_km=25)

    assert area.contains(shapely.Point(10.25, 49.5))
    assert area.contains(shapely.Point(10.6, 50.6))


def test_corridor_clamps_the_buffer_to_5_and_25_km(tmp_path):
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    short = pattern([(10.05, 50.0), (10.15, 50.0)], "short")
    long = pattern([(9.9, 50.0), (14.0, 50.0)], "long")

    short_area = corridor([short], outline, cap_km=300, share=0.2, min_km=5, max_km=25)
    long_area = corridor([long], outline, cap_km=300, share=0.2, min_km=5, max_km=25)

    assert short_area.contains(shapely.Point(10.1, 50.0 + 4.5 / 111.2))
    assert not short_area.contains(shapely.Point(10.1, 50.0 + 6.0 / 111.2))
    assert long_area.contains(shapely.Point(12.0, 50.0 + 24.0 / 111.2))
    assert not long_area.contains(shapely.Point(12.0, 50.0 + 27.0 / 111.2))


def test_corridor_of_no_leg_abroad_is_empty(tmp_path):
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)

    assert corridor([], outline, cap_km=300, share=0.2, min_km=5, max_km=25).is_empty
    assert area_km2(shapely.Polygon()) == 0.0


def test_coverage_reads_every_feature_of_the_extra_file(tmp_path):
    second = [[10.5, 49.0], [11.0, 49.0], [11.0, 51.0], [10.5, 51.0], [10.5, 49.0]]
    first = [[10.0, 49.0], [10.5, 49.0], [10.5, 51.0], [10.0, 51.0], [10.0, 49.0]]
    features = [
        {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [r]}}
        for r in (first, second)
    ]
    extra = tmp_path / "held.geojson"
    extra.write_text(json.dumps({"type": "FeatureCollection", "features": features}))

    cover = load_coverage(write_polygon(tmp_path / "de.geojson", GERMANY), extra=extra)

    assert cover.contains(point(10.7, 50.0))


def write_osm(path: Path, nodes: list, ways: list, relations: list = ()) -> Path:
    writer = osmium.SimpleWriter(str(path))
    try:
        for n in nodes:
            writer.add_node(n)
        for w in ways:
            writer.add_way(w)
        for r in relations:
            writer.add_relation(r)
    finally:
        writer.close()
    return path


def node(i: int, lon: float, lat: float, version: int = 1, **tags) -> Node:
    return Node(id=i, version=version, location=(lon, lat), tags=tags)


def way(i: int, refs: list[int], version: int = 1, **tags) -> Way:
    return Way(id=i, version=version, nodes=refs, tags=tags)


def read(path: Path) -> dict:
    out: dict = {"n": {}, "w": {}, "r": {}}
    for obj in osmium.FileProcessor(str(path)):
        if obj.is_node():
            out["n"][obj.id] = (obj.version, dict(obj.tags), obj.location.lon)
        elif obj.is_way():
            out["w"][obj.id] = (obj.version, dict(obj.tags), [n.ref for n in obj.nodes])
        else:
            out["r"][obj.id] = (obj.version, dict(obj.tags), [(m.type, m.ref) for m in obj.members])
    return out


@pytest.fixture
def region(tmp_path) -> Path:
    nodes = [
        node(1, 10.10, 50.0),
        node(2, 10.20, 50.0, railway="switch"),
        node(3, 10.30, 50.0),
        node(4, 12.00, 50.0),
        node(5, 12.10, 50.0),
        node(6, 10.15, 50.01, railway="station", name="Abroad"),
        node(7, 10.40, 50.0, highway="bus_stop"),
        node(8, 10.50, 50.0),
    ]
    ways = [
        way(10, [1, 2, 3], railway="rail"),
        way(11, [4, 5], railway="rail"),
        way(12, [3, 8], highway="primary"),
        way(13, [1, 2], railway="abandoned"),
    ]
    relations = [
        Relation(
            id=20,
            version=1,
            members=[("w", 10, ""), ("w", 11, ""), ("n", 6, "stop")],
            tags={"type": "route", "route": "train", "ref": "RE1"},
        ),
        Relation(
            id=21,
            version=1,
            members=[("w", 12, "")],
            tags={"type": "route", "route": "bus"},
        ),
    ]
    return write_osm(tmp_path / "region.osm.pbf", nodes, ways, relations)


def test_filter_keeps_track_stations_rail_routes_and_their_nodes(region, tmp_path):
    out = read(filter_rail(region, tmp_path / "rail.osm.pbf"))

    assert set(out["w"]) == {10, 11}
    assert set(out["r"]) == {20}
    assert {1, 2, 3, 4, 5, 6} <= set(out["n"])
    assert 7 not in out["n"]
    assert out["n"][2][1] == {"railway": "switch"}


def test_filter_keeps_the_tags_of_nodes_it_adds_as_references(tmp_path):
    source = write_osm(
        tmp_path / "src.osm.pbf",
        [node(1, 9.0, 50.0, highway="level_crossing"), node(2, 9.1, 50.0)],
        [way(10, [1, 2], railway="rail")],
    )

    out = read(filter_rail(source, tmp_path / "rail.osm.pbf"))

    assert out["n"][1][1] == {"highway": "level_crossing"}


def test_clip_keeps_ways_touching_the_corridor_whole_and_relations_with_all_members(
    region, tmp_path
):
    rail = filter_rail(region, tmp_path / "rail.osm.pbf")
    box = shapely.box(10.0, 49.9, 10.25, 50.1)

    out = read(clip_to_corridor(rail, tmp_path / "clip.osm.pbf", box))

    assert set(out["w"]) == {10}
    assert set(out["n"]) == {1, 2, 3, 6}
    assert out["r"][20][2] == [("w", 10), ("w", 11), ("n", 6)]


def test_merge_takes_the_newer_version_and_keeps_both_sides(tmp_path):
    base = write_osm(
        tmp_path / "de.osm.pbf",
        [node(1, 9.9, 50.0), node(2, 10.0, 50.0), node(3, 10.1, 50.0)],
        [way(10, [1, 2], railway="rail"), way(11, [2, 3], railway="rail")],
    )
    newer = write_osm(
        tmp_path / "cz.osm.pbf",
        [node(2, 10.0, 50.0), node(3, 10.12, 50.0, version=2), node(4, 10.2, 50.0)],
        [way(11, [2, 3, 4], version=2, railway="rail"), way(12, [3, 4], railway="rail")],
    )
    overlap = write_osm(
        tmp_path / "at.osm.pbf",
        [node(4, 10.2, 50.0), node(5, 10.3, 50.0)],
        [way(12, [3, 4], railway="rail"), way(13, [4, 5], railway="rail")],
    )

    merge_osm(base, [newer, overlap], tmp_path / "merged.osm.pbf")
    out = read(tmp_path / "merged.osm.pbf")

    assert sorted(out["n"]) == [1, 2, 3, 4, 5]
    assert out["n"][3][0] == 2
    assert out["n"][3][2] == pytest.approx(10.12)
    assert sorted(out["w"]) == [10, 11, 12, 13]
    assert out["w"][11] == (2, {"railway": "rail"}, [2, 3, 4])


def test_merge_keeps_the_base_copy_when_the_versions_tie(tmp_path):
    base = write_osm(
        tmp_path / "de.osm.pbf",
        [node(1, 9.0, 50.0, version=3, highway="traffic_signals"), node(2, 9.1, 50.0)],
        [way(10, [1, 2], railway="rail")],
        [
            Relation(
                id=20,
                version=5,
                members=[("w", 10, ""), ("w", 99, "")],
                tags={"type": "route", "route": "train"},
            )
        ],
    )
    addition = write_osm(
        tmp_path / "cz.osm.pbf",
        [node(1, 9.0, 50.0, version=3)],
        [],
        [
            Relation(
                id=20,
                version=5,
                members=[("w", 10, "")],
                tags={"type": "route", "route": "train"},
            )
        ],
    )

    merge_osm(base, [addition], tmp_path / "merged.osm.pbf")
    out = read(tmp_path / "merged.osm.pbf")

    assert out["n"][1][1] == {"highway": "traffic_signals"}
    assert out["r"][20][2] == [("w", 10), ("w", 99)]


def test_a_relation_in_two_additions_comes_from_the_copy_with_more_members(tmp_path):
    base = write_osm(tmp_path / "de.osm.pbf", [node(1, 9.0, 50.0)], [])
    members = {
        "ch": [("w", 10, ""), ("w", 11, ""), ("w", 12, "")],
        "at": [("w", 10, "")],
    }
    additions = [
        write_osm(
            tmp_path / f"{name}.osm.pbf",
            [],
            [],
            [Relation(id=30, version=4, members=m, tags={"type": "route", "route": "train"})],
        )
        for name, m in members.items()
    ]

    counts = merge_osm(base, additions, tmp_path / "merged.osm.pbf")
    out = read(tmp_path / "merged.osm.pbf")

    assert out["r"][30][2] == [("w", 10), ("w", 11), ("w", 12)]
    assert counts == {"added": 1, "replaced": 0, "base_kept": 0}


def test_the_base_keeps_a_higher_version_and_an_addition_replaces_a_lower_one(tmp_path):
    base = write_osm(
        tmp_path / "de.osm.pbf",
        [node(1, 9.0, 50.0, version=7, railway="signal"), node(2, 9.1, 50.0, version=1)],
        [],
    )
    addition = write_osm(
        tmp_path / "cz.osm.pbf",
        [node(1, 9.0, 50.0, version=6), node(2, 9.2, 50.0, version=2)],
        [],
    )

    counts = merge_osm(base, [addition], tmp_path / "merged.osm.pbf")
    out = read(tmp_path / "merged.osm.pbf")

    assert out["n"][1][:2] == (7, {"railway": "signal"})
    assert out["n"][2][0] == 2
    assert out["n"][2][2] == pytest.approx(9.2)
    assert counts == {"added": 0, "replaced": 1, "base_kept": 1}


def test_held_area_is_the_corridor_inside_the_downloaded_regions(tmp_path):
    index = {
        "features": [
            {
                "properties": {"id": "east"},
                "geometry": {"type": "Polygon", "coordinates": [ABROAD]},
            },
            {
                "properties": {"id": "far"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[11, 49], [12, 49], [12, 51], [11, 51], [11, 49]]],
                },
            },
        ]
    }
    (tmp_path / "index.json").write_text(json.dumps(index))
    area = shapely.box(9.5, 49.5, 11.5, 50.5)

    held = held_area(area, ["east"], tmp_path / "index.json")

    assert held.contains(shapely.Point(10.5, 50.0))
    assert not held.contains(shapely.Point(11.2, 50.0))
    assert not held.contains(shapely.Point(9.7, 50.0))
    with pytest.raises(ValueError, match="nowhere"):
        held_area(area, ["nowhere"], tmp_path / "index.json")


def test_route_kinds_come_from_every_file(region, tmp_path):
    other = write_osm(
        tmp_path / "other.osm.pbf",
        [],
        [],
        [
            Relation(
                id=30,
                version=1,
                members=[("w", 10, "")],
                tags={"type": "route", "route": "train", "service": "commuter"},
            )
        ],
    )

    kinds = route_kinds_by_way_in([region, other])

    assert kinds[10] == {"main", "sbahn"}
    assert kinds[11] == {"main"}
    assert 12 not in kinds


def test_commands_draw_the_corridor_clip_merge_and_cache_both_routes(region, tmp_path, capsys):
    import numpy as np  # noqa: PLC0415

    from gerlines_rail_graph.cli import main  # noqa: PLC0415

    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    work = tmp_path / "work"
    work.mkdir()
    leg = pattern([(9.9, 50.0), (10.3, 50.0)])
    (work / "patterns.json").write_text(json.dumps([leg.as_json()]))
    german = write_osm(
        tmp_path / "germany.osm.pbf",
        [node(90, 9.8, 50.0), node(1, 10.1, 50.0)],
        [way(91, [90, 1], railway="rail")],
        [
            Relation(
                id=92,
                version=1,
                members=[("w", 91, "")],
                tags={"type": "route", "route": "train", "ref": "S1"},
            )
        ],
    )
    corridor_file = tmp_path / "corridor.geojson"
    grown = tmp_path / "corridor-2.geojson"
    other = tmp_path / "patterns-2.json"
    other.write_text(json.dumps([pattern([(9.9, 49.5), (10.3, 49.5)], "p2").as_json()]))
    index = tmp_path / "index.json"
    index.write_text(
        json.dumps(
            {
                "features": [
                    {
                        "properties": {"id": "region"},
                        "geometry": {"type": "Polygon", "coordinates": [ABROAD]},
                    }
                ]
            }
        )
    )
    out = tmp_path / "neighbours"
    merged = tmp_path / "merged.osm.pbf"
    osm_dir = tmp_path / "osm"
    patterns_file = work / "patterns.json"

    main(
        [
            "corridor",
            "--patterns",
            str(patterns_file),
            "--outline",
            str(outline),
            "--out",
            str(corridor_file),
        ]
    )
    main(
        [
            "corridor",
            "--patterns",
            str(other),
            "--outline",
            str(outline),
            "--previous",
            str(corridor_file),
            "--out",
            str(grown),
        ]
    )
    main(
        [
            "neighbours",
            "--corridor",
            str(corridor_file),
            "--index",
            str(index),
            "--out",
            str(out),
            str(region),
        ]
    )
    clipped = out / "region-corridor.osm.pbf"
    main(["merge-osm", "--base", str(german), "--add", str(clipped), "--out", str(merged)])
    main(
        [
            "osm",
            "--rail-pbf",
            str(merged),
            "--full-pbf",
            str(german),
            "--full-pbf",
            str(clipped),
            "--out",
            str(osm_dir),
        ]
    )

    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["step"] for line in lines] == [
        "corridor",
        "corridor",
        "neighbours",
        "merge-osm",
        "osm",
    ]
    assert lines[0]["removed_km2"] == 0
    assert lines[1]["added_km2"] > 0
    assert lines[1]["removed_km2"] == 0
    assert lines[1]["previous_not_drawn_km2"] > 0
    assert read_polygon(grown).contains(read_polygon(corridor_file))
    assert lines[2]["regions"]["region"]["corridor"]["ways"] == 1
    assert 0 < lines[2]["held_km2"] < lines[2]["corridor_km2"]
    assert not (out / "region-rail.osm.pbf").exists()
    region_meta = json.loads((out / "region-corridor.osm.pbf.json").read_text())
    assert region_meta["sha256"] == sha256_of(clipped)
    assert region_meta["source_sha256"] == sha256_of(region)
    merged_meta = json.loads((tmp_path / "merged.osm.pbf.json").read_text())
    assert merged_meta["sha256"] == sha256_of(merged)
    assert merged_meta["additions"][0]["sha256"] == sha256_of(clipped)
    assert read_polygon(out / "held.geojson").within(read_polygon(corridor_file).buffer(1e-9))
    assert set(read(merged)["w"]) == {10, 91}
    with np.load(osm_dir / "way_kinds.npz") as kinds:
        assert dict(zip(kinds["way_ids"].tolist(), kinds["bits"].tolist(), strict=True)) == {
            10: 2,
            11: 2,
            91: 1,
        }


def test_coverage_takes_part_in_the_evaluation_fingerprint(tmp_path):
    import argparse  # noqa: PLC0415

    from gerlines_rail_graph.pipeline import evaluate_key  # noqa: PLC0415

    work = tmp_path / "work"
    work.mkdir()
    (work / "patterns.json").write_text("[]")
    for method in ("motis", "pfaedle"):
        (work / "candidates" / method).mkdir(parents=True)
    outline = write_polygon(tmp_path / "de.geojson", GERMANY)
    held = write_polygon(tmp_path / "held.geojson", ABROAD)
    wider = write_polygon(
        tmp_path / "wider.geojson", [[10, 48], [12, 48], [12, 52], [10, 52], [10, 48]]
    )

    def key(coverage):
        return evaluate_key(
            argparse.Namespace(
                work=work,
                osm=tmp_path,
                outline=outline,
                coverage=coverage,
                chunk_size=250,
                sample=None,
            )
        )

    assert len({key(None), key(held), key(wider)}) == 3


def test_a_kept_rail_filter_is_clipped_again_without_being_filtered_over(region, tmp_path, capsys):
    import os  # noqa: PLC0415

    from gerlines_rail_graph.cli import main  # noqa: PLC0415

    kept = tmp_path / "no"
    kept.mkdir()
    rail = filter_rail(region, kept / "region-rail.osm.pbf")
    (kept / "region-rail.osm.pbf.json").write_text(
        json.dumps({"region": "region", "raw_sha256": "abc", "url": "https://example.test/r.pbf"})
    )
    before = rail.read_bytes()
    corridor_file = write_polygon(tmp_path / "corridor.geojson", ABROAD)
    index = tmp_path / "index.json"
    index.write_text(
        json.dumps(
            {
                "features": [
                    {
                        "properties": {"id": "region"},
                        "geometry": {"type": "Polygon", "coordinates": [ABROAD]},
                    }
                ]
            }
        )
    )
    cwd = Path.cwd()
    os.chdir(tmp_path)
    try:
        main(
            [
                "neighbours",
                "--corridor",
                str(corridor_file),
                "--index",
                str(index),
                "--out",
                "no",
                "--keep-rail",
                str(rail),
            ]
        )
    finally:
        os.chdir(cwd)

    assert rail.read_bytes() == before
    meta = json.loads((kept / "region-corridor.osm.pbf.json").read_text())
    assert meta["filtered_from"] == {
        "region": "region",
        "raw_sha256": "abc",
        "url": "https://example.test/r.pbf",
    }
    assert meta["source_sha256"] == sha256_of(rail)
    capsys.readouterr()


def test_filtering_writes_a_rail_sidecar_with_the_raw_download(region, tmp_path, capsys):
    from gerlines_rail_graph.cli import main  # noqa: PLC0415

    (tmp_path / "region.osm.pbf.json").write_text(
        json.dumps({"url": "https://example.test/region.pbf", "sha256": "raw", "md5": "m"})
    )
    corridor_file = write_polygon(tmp_path / "corridor.geojson", ABROAD)
    index = tmp_path / "index.json"
    index.write_text(
        json.dumps(
            {
                "features": [
                    {
                        "properties": {"id": "region"},
                        "geometry": {"type": "Polygon", "coordinates": [ABROAD]},
                    }
                ]
            }
        )
    )
    out = tmp_path / "no"

    main(
        [
            "neighbours",
            "--corridor",
            str(corridor_file),
            "--index",
            str(index),
            "--out",
            str(out),
            "--keep-rail",
            str(region),
        ]
    )

    rail_meta = json.loads((out / "region-rail.osm.pbf.json").read_text())
    assert rail_meta["url"] == "https://example.test/region.pbf"
    assert rail_meta["raw_sha256"] == "raw"
    assert rail_meta["sha256"] == sha256_of(out / "region-rail.osm.pbf")
    assert rail_meta["filter_version"] == FILTER_VERSION
    corridor_meta = json.loads((out / "region-corridor.osm.pbf.json").read_text())
    assert corridor_meta["filtered_from"]["raw_sha256"] == "raw"
    capsys.readouterr()


def test_neighbours_refuses_an_unknown_region_before_filtering(region, tmp_path):
    from gerlines_rail_graph.cli import main  # noqa: PLC0415

    corridor_file = write_polygon(tmp_path / "corridor.geojson", ABROAD)
    index = tmp_path / "index.json"
    index.write_text(json.dumps({"features": []}))

    with pytest.raises(ValueError, match="region"):
        main(
            [
                "neighbours",
                "--corridor",
                str(corridor_file),
                "--index",
                str(index),
                "--out",
                str(tmp_path / "no"),
                "--keep-rail",
                str(region),
            ]
        )

    assert not (tmp_path / "no" / "region-rail.osm.pbf").exists()


def test_source_md_reads_the_sidecar_when_the_download_was_deleted(tmp_path, capsys):
    from gerlines_rail_graph.cli import main  # noqa: PLC0415

    folder = tmp_path / "osm-neighbours"
    folder.mkdir()
    kept = tmp_path / "kept"
    kept.mkdir()
    (kept / "cz-rail.osm.pbf").write_bytes(b"")
    (folder / "cz.osm.pbf.json").write_text(
        json.dumps(
            {
                "file": "cz.osm.pbf",
                "url": "https://example.test/cz.pbf",
                "bytes": 10,
                "md5": "m",
                "sha256": "s",
                "osm_replication_timestamp": "2026-11-07T21:21:36Z",
            }
        )
    )

    main(["source-md", "--dir", str(folder), "--kept", str(kept)])

    text = (folder / "SOURCE.md").read_text()
    assert "2026-11-07T21:21:36Z" in text
    assert "deleted" in text
    assert "Kept:" in text
    assert str(kept) in text
    capsys.readouterr()
