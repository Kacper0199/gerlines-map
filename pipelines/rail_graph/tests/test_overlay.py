import json
from pathlib import Path

import numpy as np

from gerlines_rail_graph.overlay import corridor_data, write_preview

TRIP = {
    "route_short_name": "S1",
    "trip_short_name": "",
    "headsign": "Oranienburg",
    "category": "sbahn",
    "stops": [["a", "Inside", 13.40, 52.52, 0, 0], ["b", "Far away", 14.0, 53.0, 0, 0]],
}


def test_shapes_and_rail_are_clipped_to_the_corridor_and_far_stops_left_out():
    data = corridor_data(
        "test",
        (13.3, 52.5, 13.5, 52.6),
        {"t1": TRIP},
        {"delfi": {"t1": [[13.0, 52.55], [14.0, 52.55]]}, "pfaedle": {"t1": None}},
        [np.array([[13.35, 52.55], [13.45, 52.55]])],
    )

    xs = [c[0] for c in data["methods"][0]["data"]["features"][0]["geometry"]["coordinates"]]
    assert min(xs) >= 13.29
    assert max(xs) <= 13.51
    assert data["methods"][1]["data"]["features"] == []
    assert len(data["rail"]["features"]) == 1
    assert [f["properties"]["name"] for f in data["stops"]["features"]] == ["Inside"]
    assert data["trips"] == ["S1 to Oranienburg (sbahn, trip t1)"]


def test_preview_folder_holds_the_page_and_one_file_per_corridor(tmp_path: Path):
    write_preview(tmp_path, {"koeln": {"title": "k"}})

    assert "maplibre-gl@5.24.0" in (tmp_path / "index.html").read_text()
    assert json.loads((tmp_path / "data" / "koeln.json").read_text()) == {"title": "k"}


def test_a_corridor_shows_only_patterns_whose_shape_crosses_it():
    from gerlines_rail_graph.patterns import Pattern  # noqa: PLC0415
    from gerlines_rail_graph.pipeline_shapes import corridor_patterns  # noqa: PLC0415

    def pattern(pid: str, km: float) -> Pattern:
        return Pattern(pid, "r", "ICE", "hsr", 0, [], "t", None, 0, 1, 1, km)

    shapes = {
        "through": np.array([[9.0, 50.0], [10.0, 51.0]]),
        "around": np.array([[9.0, 50.0], [9.0, 51.0], [10.0, 51.0]]),
    }
    keys = np.array(sorted(shapes))
    bounds = np.array([[*shapes[k].min(axis=0), *shapes[k].max(axis=0)] for k in keys])
    patterns = {"through": pattern("through", 10.0), "around": pattern("around", 99.0)}

    picked = corridor_patterns(
        bounds, keys, (9.4, 50.4, 9.6, 50.6), patterns, 1, lambda k: shapes[k]
    )

    assert picked == ["through"]
