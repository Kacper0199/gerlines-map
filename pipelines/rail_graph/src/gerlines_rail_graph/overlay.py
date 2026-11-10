"""Preview folder for overlay screenshots: OSM rail and every method's shape per corridor."""

import json
from importlib.resources import files
from pathlib import Path

import numpy as np
import shapely
from shapely import box

METHOD_STYLE = {
    "delfi": {"color": "#d95f02", "width": 9, "opacity": 0.55, "label": "DELFI shapes.txt"},
    "motis": {"color": "#1b9e77", "width": 5, "opacity": 0.85, "label": "MOTIS route_shapes"},
    "pfaedle": {"color": "#7570b3", "width": 2.2, "opacity": 1.0, "label": "pfaedle"},
    "final-motis": {"color": "#1b9e77", "width": 4, "opacity": 0.9, "label": "chosen: MOTIS"},
    "final-pfaedle": {"color": "#7570b3", "width": 4, "opacity": 0.9, "label": "chosen: pfaedle"},
    "final-straight": {
        "color": "#d95f02",
        "width": 3,
        "opacity": 0.9,
        "label": "low quality: straight stop to stop",
    },
}


RAIL_CLASS = {0: "none", 1: "untyped", 2: "sbahn", 3: "main", 4: "shared"}


def _lines(geometry, props: dict) -> list[dict]:
    return [
        {
            "type": "Feature",
            "properties": props,
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(x, 6), round(y, 6)] for x, y in part.coords],
            },
        }
        for part in shapely.get_parts(geometry)
        if part.geom_type == "LineString" and len(part.coords) >= 2
    ]


def _label(trip_id: str, trip: dict) -> str:
    name = trip["route_short_name"] or trip["trip_short_name"]
    return f"{name} to {trip['headsign']} ({trip['category']}, trip {trip_id})"


def corridor_data(  # noqa: PLR0913, PLR0917
    title: str,
    bbox: tuple[float, float, float, float],
    trips: dict[str, dict],
    methods: dict[str, dict[str, list | None]],
    rail_lonlat: list[np.ndarray],
    rail_classes: np.ndarray | None = None,
) -> dict:
    """GeoJSON for one corridor: each method's shapes clipped to the box, OSM rail, stops."""
    area = box(*bbox).buffer(0.01)
    layers = []
    for name, shapes in methods.items():
        features = []
        for t in trips:
            raw = shapes.get(t)
            if raw:
                features += _lines(
                    shapely.intersection(shapely.linestrings(raw), area), {"trip": t}
                )
        layers.append(
            {
                "name": name,
                **METHOD_STYLE[name],
                "data": {"type": "FeatureCollection", "features": features},
            }
        )
    rail = []
    for k, coords in enumerate(rail_lonlat):
        props = {"cls": RAIL_CLASS[int(rail_classes[k])]} if rail_classes is not None else {}
        rail += _lines(shapely.intersection(shapely.linestrings(coords), area), props)
    stops = [
        {
            "type": "Feature",
            "properties": {"name": s[1]},
            "geometry": {"type": "Point", "coordinates": [s[2], s[3]]},
        }
        for trip in trips.values()
        for s in trip["stops"]
        if area.contains(shapely.Point(s[2], s[3]))
    ]
    return {
        "title": title,
        "bounds": [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        "methods": layers,
        "rail": {"type": "FeatureCollection", "features": rail},
        "stops": {"type": "FeatureCollection", "features": stops},
        "trips": [_label(t, trip) for t, trip in trips.items()],
    }


def write_preview(folder: Path, corridors: dict[str, dict]) -> None:
    (folder / "data").mkdir(parents=True, exist_ok=True)
    page = files("gerlines_rail_graph").joinpath("overlay.html").read_text()
    (folder / "index.html").write_text(page)
    for name, data in corridors.items():
        (folder / "data" / f"{name}.json").write_text(json.dumps(data))
    (folder / "data" / "index.json").write_text(json.dumps(sorted(corridors)))
