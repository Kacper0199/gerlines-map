"""Command line of the SP-3 shape comparison; every reported number comes from it."""

import argparse
import json
import resource
import sys
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

from gerlines_rail_graph.pipeline import register
from gerlines_rail_graph.pipeline_neighbours import register as register_neighbours
from gerlines_rail_graph.pipeline_shapes import register as register_shapes


def _peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576


def _report(name: str, started: float, extra: dict) -> None:
    print(
        json.dumps(
            {
                "step": name,
                "wall_s": round(time.time() - started, 1),
                "peak_rss_mb": round(_peak_rss_mb()),
                **extra,
            }
        )
    )


def cmd_osm(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.osm import read_rail_ways, route_kinds_by_way_in  # noqa: PLC0415

    started = time.time()
    args.out.mkdir(parents=True, exist_ok=True)
    ways = read_rail_ways(args.rail_pbf)
    ways.save(args.out / "ways.npz")
    kinds = route_kinds_by_way_in(args.full_pbf)
    ids = np.array(sorted(kinds), dtype=np.int64)
    bits = np.array(
        [("sbahn" in kinds[i]) | (("main" in kinds[i]) << 1) for i in ids], dtype=np.int8
    )
    np.savez_compressed(args.out / "way_kinds.npz", way_ids=ids, bits=bits)
    in_extract = np.isin(ways.way_ids, ids)
    _report(
        "osm",
        started,
        {
            "rail_ways": len(ways),
            "nodes": len(ways.node_ids),
            "railway_values": {
                str(k): int(v)
                for k, v in zip(*np.unique(ways.railway, return_counts=True), strict=True)
            },
            "ways_in_passenger_routes": len(ids),
            "extract_ways_in_routes": int(in_extract.sum()),
        },
    )


def _flagged_trips(report: Path | None) -> set[str]:
    if report is None:
        return set()
    notices = json.loads(report.read_text())["notices"]
    return {
        sample["tripId"]
        for notice in notices
        if notice["code"] == "stop_too_far_from_shape"
        for sample in notice["sampleNotices"]
    }


def _trip_record(  # noqa: PLR0913, PLR0917
    t: str, trip, route, cat: str, stop_rows: list, stops: dict, flagged: set
) -> dict:
    return {
        "route_id": trip.route_id,
        "direction_id": trip.direction_id,
        "route_type": route.route_type,
        "route_short_name": route.short_name,
        "agency_id": route.agency_id,
        "trip_short_name": trip.short_name,
        "headsign": trip.headsign,
        "category": cat,
        "shape_id": trip.shape_id,
        "flagged": t in flagged,
        "stops": [[s, stops[s].name, stops[s].lon, stops[s].lat, a, d] for s, a, d in stop_rows],
    }


def cmd_sample(args: argparse.Namespace) -> None:
    import random  # noqa: PLC0415
    from datetime import date  # noqa: PLC0415

    import shapely  # noqa: PLC0415

    from gerlines_rail_graph import gtfs  # noqa: PLC0415
    from gerlines_rail_graph.index import load_coverage  # noqa: PLC0415
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415
    from gerlines_rail_graph.sample import (  # noqa: PLC0415
        CORRIDORS,
        Pattern,
        TripStops,
        category,
        pick_corridor_trips,
        serves_corridor,
        stratified_patterns,
    )

    started = time.time()
    day = date.fromisoformat(args.date)
    stops = gtfs.read_stops(args.gtfs)
    routes = gtfs.read_routes(args.gtfs)
    trips = gtfs.read_trips(args.gtfs)
    services = gtfs.active_services(args.gtfs, day)
    active = {t for t, trip in trips.items() if trip.service_id in services}
    stop_times = {t: st for t, st in gtfs.read_stop_times(args.gtfs, active).items() if len(st) > 1}
    flagged = _flagged_trips(args.validation_report)
    germany = load_coverage(args.outline, inset_m=0.0)
    categories = {
        t: category(routes[trips[t].route_id].route_type, routes[trips[t].route_id].short_name)
        for t in stop_times
    }
    by_pattern: dict[str, list[str]] = {}
    for t, st in stop_times.items():
        key = f"{trips[t].route_id}|{trips[t].direction_id}|" + ",".join(s for s, _, _ in st)
        by_pattern.setdefault(key, []).append(t)
    patterns = []
    scope: dict[str, str] = {}
    for key, ids in by_pattern.items():
        first = min(ids, key=lambda t: (stop_times[t][0][2], t))
        lonlat = np.array([[stops[s].lon, stops[s].lat] for s, _, _ in stop_times[first]])
        xy = to_xy(lonlat[:, 0], lonlat[:, 1])
        length_km = float(np.hypot(*np.diff(xy, axis=0).T).sum() / 1000)
        inside = shapely.contains_xy(germany, xy[:, 0], xy[:, 1])
        scope[key] = "domestic" if inside.all() else "cross_border"
        patterns.append(Pattern(key, categories[first], tuple(sorted(ids)), length_km))
    rng = random.Random(args.seed)  # noqa: S311
    strata = stratified_patterns(patterns, args.per_category, rng)
    representative = {
        p.key: min(p.trips, key=lambda t: (stop_times[t][0][2], t))
        for picked in strata.values()
        for p in picked
    }
    trip_stops = {
        t: TripStops(
            names=[stops[s].name for s, _, _ in st],
            lonlat=[(stops[s].lon, stops[s].lat) for s, _, _ in st],
        )
        for t, st in stop_times.items()
    }
    corridor_rng = random.Random(args.seed + 1)  # noqa: S311
    corridors: dict[str, list[str]] = {}
    for corridor in CORRIDORS:
        candidates = {
            t: (
                categories[t],
                trips[t].route_id + "|" + ",".join(s for s, _, _ in stop_times[t]),
                t in flagged,
            )
            for t, ts in trip_stops.items()
            if serves_corridor(ts, corridor)
        }
        corridors[corridor.name] = pick_corridor_trips(candidates, args.per_corridor, corridor_rng)
    pattern_of = {representative[p.key]: p for picked in strata.values() for p in picked}
    selected = sorted({t for ids in corridors.values() for t in ids} | set(pattern_of))
    out = {
        "date": args.date,
        "gtfs": str(args.gtfs),
        "seed": args.seed,
        "corridors": corridors,
        "strata": {cat: [representative[p.key] for p in picked] for cat, picked in strata.items()},
        "national": sorted(pattern_of),
        "patterns": {
            t: {
                "key": p.key,
                "trips": len(p.trips),
                "length_km": round(p.length_km, 3),
                "train_km": round(p.train_km, 3),
                "scope": scope[p.key],
            }
            for t, p in pattern_of.items()
        },
        "trips": {
            t: _trip_record(
                t,
                trips[t],
                routes[trips[t].route_id],
                categories[t],
                stop_times[t],
                stops,
                flagged,
            )
            for t in selected
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False))
    population: dict[str, dict[str, float]] = {}
    for p in patterns:
        entry = population.setdefault(p.category, {"patterns": 0, "train_km": 0.0})
        entry["patterns"] += 1
        entry["train_km"] = round(entry["train_km"] + p.train_km)
    _report(
        "sample",
        started,
        {
            "active_trips": len(active),
            "patterns": len(patterns),
            "population": population,
            "strata": {
                cat: {
                    "patterns": len(picked),
                    "cross_border": sum(scope[p.key] == "cross_border" for p in picked),
                    "train_km": round(sum(p.train_km for p in picked)),
                }
                for cat, picked in strata.items()
            },
            "corridor_trips": {k: len(v) for k, v in corridors.items()},
            "selected": len(selected),
        },
    )


def cmd_motis(args: argparse.Namespace) -> None:
    from collections import Counter  # noqa: PLC0415

    from gerlines_rail_graph.motis import fetch_trip, slice_to_trip, trip_id  # noqa: PLC0415

    started = time.time()
    sample = json.loads(args.sample.read_text())
    out: dict[str, list | None] = {}
    how_by_trip: dict[str, str] = {}
    found: Counter[str] = Counter()
    latencies = []
    for t, trip in sorted(sample["trips"].items()):
        motis_id = trip_id(sample["date"], trip["stops"][0][5], t, args.tag)
        begun = time.perf_counter()
        try:
            itinerary = fetch_trip(args.base_url, motis_id)
        except OSError as error:
            how_by_trip[t] = f"error {motis_id}: {error}"
            found["error"] += 1
            out[t] = None
            continue
        latencies.append((time.perf_counter() - begun) * 1000)
        points, how = slice_to_trip(
            itinerary,
            [s[0] for s in trip["stops"]],
            args.tag,
            [(s[2], s[3]) for s in trip["stops"]],
        )
        how_by_trip[t] = how
        found[how.split("_not_in_run_")[0] + ("_not_in_run" if "_not_in_run_" in how else "")] += 1
        out[t] = [list(p) for p in points] if points else None
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out))
    args.out.with_suffix(".how.json").write_text(json.dumps(how_by_trip, indent=1))
    lat = np.array(latencies)
    _report(
        "motis",
        started,
        {
            "trips": len(out),
            "with_shape": sum(1 for v in out.values() if v),
            "geometry_found": dict(found),
            "latency_ms_p50": round(float(np.percentile(lat, 50)), 1) if lat.size else None,
            "latency_ms_max": round(float(lat.max()), 1) if lat.size else None,
        },
    )


def _row_lonlat(row: dict) -> dict:
    from gerlines_rail_graph.project import to_lonlat  # noqa: PLC0415

    runs = row["off_relation_runs"]
    if runs:
        lonlat = to_lonlat(np.array([[r[0], r[1]] for r in runs]))
        row["off_relation_runs"] = [
            [round(float(lon), 6), round(float(lat), 6), round(r[2], 1)]
            for (lon, lat), r in zip(lonlat, runs, strict=True)
        ]
    return row


def cmd_evaluate(args: argparse.Namespace) -> None:
    from shapely import box  # noqa: PLC0415

    from gerlines_rail_graph.evaluate import aggregate, as_row, evaluate_trip  # noqa: PLC0415
    from gerlines_rail_graph.index import load_rail_index  # noqa: PLC0415
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415
    from gerlines_rail_graph.sample import CORRIDORS  # noqa: PLC0415

    started = time.time()
    sample = json.loads(args.sample.read_text())
    index, nodes = load_rail_index(args.osm, args.outline)
    built = time.time() - started
    methods = {}
    for spec in args.method:
        name, path = spec.split("=", 1)
        methods[name] = json.loads(Path(path).read_text())
    areas = {}
    for corridor in CORRIDORS:
        lon0, lat0, lon1, lat1 = corridor.bbox
        corner = to_xy(np.array([lon0, lon1]), np.array([lat0, lat1]))
        areas[corridor.name] = box(*corner[0], *corner[1]).buffer(1000)
    leg_cache: dict = {}
    per_trip: dict[str, dict[str, dict]] = {}
    groups: dict[str, dict[str, list]] = {}
    weights: dict[str, list[float]] = {}
    in_corridor: dict[str, list[str]] = {}
    for name, ids in sample["corridors"].items():
        for t in ids:
            in_corridor.setdefault(t, []).append(name)
    for t, trip in sorted(sample["trips"].items()):
        stops = np.array([[s[2], s[3]] for s in trip["stops"]])
        stops_xy = to_xy(stops[:, 0], stops[:, 1])
        keys = [s[0] for s in trip["stops"]]
        is_sbahn = trip["category"] == "sbahn"
        pattern = sample["patterns"].get(t)
        strata = []
        if pattern:
            strata = [f"{trip['category']}:{pattern['scope']}", f"all:{pattern['scope']}"]
            for group in strata:
                weights.setdefault(group, []).append(pattern["train_km"])
        per_trip[t] = {}
        for method, shapes in methods.items():
            raw = shapes.get(t)
            shape_xy = None
            if raw:
                arr = np.array(raw)
                shape_xy = to_xy(arr[:, 0], arr[:, 1])
            whole = evaluate_trip(
                stops_xy, shape_xy, index, is_sbahn=is_sbahn, legs=(leg_cache, keys)
            )
            per_trip[t][method] = _row_lonlat(as_row(whole))
            for group in strata:
                groups.setdefault(group, {}).setdefault(method, []).append(whole)
            for c in in_corridor.get(t, []):
                local = evaluate_trip(
                    stops_xy,
                    shape_xy,
                    index,
                    is_sbahn=is_sbahn,
                    area=areas[c],
                    legs=(leg_cache, keys),
                )
                groups.setdefault(f"corridor:{c}", {}).setdefault(method, []).append(local)
    results = {
        group: {method: aggregate(items, weights.get(group)) for method, items in by_method.items()}
        for group, by_method in sorted(groups.items())
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(results, indent=1))
    (args.out / "per-trip.json").write_text(json.dumps(per_trip))
    _report(
        "evaluate",
        started,
        {
            "index_build_s": round(built, 1),
            "graph_nodes": nodes,
            "graph_edges": index.graph.edge_count,
            "graph_km": round(index.graph.total_length_m / 1000),
            "legs_cached": len(leg_cache),
            "legs_without_path": sum(1 for v in leg_cache.values() if v is None),
        },
    )


def cmd_gate(args: argparse.Namespace) -> None:
    """Verdicts per method and the MOTIS-first choice per route and direction, over the strata."""
    from collections import Counter  # noqa: PLC0415

    from gerlines_rail_graph.gate import (  # noqa: PLC0415
        PRIMARY,
        SECONDARY,
        choose_group,
        trip_outcome,
        verdict,
    )

    per_trip = json.loads(args.per_trip.read_text())
    sample = json.loads(args.sample.read_text())
    patterns = sample["patterns"]
    ids = sample["national"]
    groups: dict[tuple[str, str], list[str]] = {}
    for t in ids:
        trip = sample["trips"][t]
        groups.setdefault((trip["route_id"], trip["direction_id"]), []).append(t)
    group_method = {
        key: choose_group([per_trip[t] for t in members]) for key, members in groups.items()
    }
    outcome = {}
    for key, members in groups.items():
        for t in members:
            outcome[t] = trip_outcome(per_trip[t], group_method[key])

    def summary(members: list[str]) -> dict:
        km = sum(patterns[t]["train_km"] for t in members) or 1.0
        verdicts = {
            m: Counter(verdict(per_trip[t][m]).value for t in members)
            for m in (PRIMARY, SECONDARY, "delfi")
            if m in per_trip[members[0]]
        }
        chosen = [per_trip[t][outcome[t]] for t in members if outcome[t] in (PRIMARY, SECONDARY)]
        return {
            "patterns": len(members),
            "train_km": round(km),
            "verdicts": {m: dict(c) for m, c in verdicts.items()},
            "outcome": dict(Counter(outcome[t] for t in members)),
            "train_km_share_low_quality": round(
                sum(patterns[t]["train_km"] for t in members if outcome[t] == "low_quality") / km,
                4,
            ),
            "chosen_off_relation_runs": sum(len(r["off_relation_runs"]) for r in chosen),
            "chosen_off_relation_km": round(sum(r["off_relation_m"] for r in chosen) / 1000, 2),
            "chosen_stop_over_80m": sum((r["max_stop_m"] or 0) > 80 for r in chosen),
        }

    report: dict[str, dict] = {
        "groups": {
            "route_direction_groups": len(groups),
            "groups_on_pfaedle": sum(m == SECONDARY for m in group_method.values()),
        }
    }
    for cat, members in sorted(sample["strata"].items()):
        for scope in ("domestic", "cross_border"):
            subset = [t for t in members if patterns[t]["scope"] == scope]
            if subset:
                report[f"{cat}:{scope}"] = summary(subset)
    for scope in ("domestic", "cross_border"):
        subset = [t for t in ids if patterns[t]["scope"] == scope]
        if subset:
            report[f"all:{scope}"] = summary(subset)
    args.out.write_text(json.dumps({"report": report, "outcome": outcome}, indent=1))
    print(json.dumps(report))


def cmd_hits(args: argparse.Namespace) -> None:
    """Random off-relation runs per method, as overlay pages at zoom 17, for a precision check."""
    import random  # noqa: PLC0415

    sample = json.loads(args.sample.read_text())
    per_trip = json.loads(args.per_trip.read_text())
    rng = random.Random(args.seed)  # noqa: S311
    picked: dict[str, list] = {}
    for method in args.methods.split(","):
        runs = [
            (t, i, run)
            for t in sorted(sample["national"])
            for i, run in enumerate(per_trip[t][method]["off_relation_runs"])
        ]
        rng.shuffle(runs)
        picked[method] = [
            {"trip": t, "run": i, "lon": run[0], "lat": run[1], "length_m": run[2]}
            for t, i, run in runs[: args.count]
        ]
        print(
            json.dumps({"method": method, "runs_total": len(runs), "picked": len(picked[method])})
        )
    args.out.write_text(json.dumps(picked, indent=1))


def cmd_legs(args: argparse.Namespace) -> None:
    """Legs of the domestic strata trips whose shape is over ``--extra`` metres longer than rail."""
    from shapely import LineString  # noqa: PLC0415

    from gerlines_rail_graph.index import load_rail_index  # noqa: PLC0415
    from gerlines_rail_graph.metrics import forward_positions  # noqa: PLC0415
    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415

    sample = json.loads(args.sample.read_text())
    shapes = json.loads(args.shapes.read_text())
    index, _ = load_rail_index(args.osm, args.outline)
    found = []
    for t in sorted(sample["national"]):
        if sample["patterns"][t]["scope"] != "domestic" or not shapes.get(t):
            continue
        trip = sample["trips"][t]
        lonlat = np.array([[s[2], s[3]] for s in trip["stops"]])
        xy = to_xy(lonlat[:, 0], lonlat[:, 1])
        arr = np.array(shapes[t])
        along = forward_positions(LineString(to_xy(arr[:, 0], arr[:, 1])), xy)
        for j in range(len(xy) - 1):
            rail = index.graph.path_length(tuple(xy[j]), tuple(xy[j + 1]))
            shape_m = float(along[j + 1] - along[j])
            if rail and shape_m - rail > args.extra:
                found.append(
                    {
                        "trip": t,
                        "line": trip["route_short_name"],
                        "from": trip["stops"][j][1],
                        "to": trip["stops"][j + 1][1],
                        "rail_m": round(rail),
                        "shape_m": round(shape_m),
                    }
                )
    found.sort(key=lambda leg: leg["rail_m"] - leg["shape_m"])
    print(json.dumps({"legs": len(found), "worst": found[: args.top]}, ensure_ascii=False))


def cmd_shapes(args: argparse.Namespace) -> None:
    from gerlines_rail_graph import gtfs  # noqa: PLC0415

    started = time.time()
    sample = json.loads(args.sample.read_text())
    wanted = set(sample["trips"])
    shape_of = {
        r["trip_id"]: r.get("shape_id", "")
        for r in gtfs.rows(args.feed, "trips.txt")
        if r["trip_id"] in wanted
    }
    shapes = gtfs.read_shapes(args.feed, {s for s in shape_of.values() if s})
    out = {t: shapes.get(shape_of.get(t, "")) for t in sorted(wanted)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out))
    _report(
        "shapes",
        started,
        {
            "feed": str(args.feed),
            "trips": len(out),
            "with_shape": sum(1 for v in out.values() if v),
        },
    )


def _overlay_trips(corridor_ids: list[str], sample: dict, per_trip: dict, count: int) -> list[str]:
    """The trip where the methods disagree most, then trips of other categories."""

    def badness(t: str) -> float:
        values = [
            (m.get("max_stop_m") or 0) + (m.get("off_relation_m") or 0) / 10
            for m in per_trip.get(t, {}).values()
        ]
        return max(values, default=0)

    ranked = sorted(corridor_ids, key=badness, reverse=True)
    picked: list[str] = []
    seen: set[str] = set()
    for t in ranked:
        cat = sample["trips"][t]["category"]
        if not picked or cat not in seen:
            picked.append(t)
            seen.add(cat)
        if len(picked) == count:
            break
    return picked


def cmd_overlay(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.index import way_classes  # noqa: PLC0415
    from gerlines_rail_graph.osm import RailWays  # noqa: PLC0415
    from gerlines_rail_graph.overlay import corridor_data, write_preview  # noqa: PLC0415
    from gerlines_rail_graph.project import to_lonlat  # noqa: PLC0415
    from gerlines_rail_graph.sample import CORRIDORS  # noqa: PLC0415

    started = time.time()
    sample = json.loads(args.sample.read_text())
    per_trip = json.loads(args.per_trip.read_text())
    methods = {}
    for spec in args.method:
        name, path = spec.split("=", 1)
        methods[name] = json.loads(Path(path).read_text())
    ways = RailWays.load(args.osm / "ways.npz")
    classes = way_classes(args.osm, ways)
    lonlat = to_lonlat(ways.xy)
    way_of_point = np.repeat(np.arange(len(ways)), np.diff(ways.offsets))

    def rail_in(bbox: tuple[float, float, float, float]) -> tuple[list[np.ndarray], np.ndarray]:
        lon0, lat0, lon1, lat1 = bbox
        pad = 0.02
        inside = (
            (lonlat[:, 0] >= lon0 - pad)
            & (lonlat[:, 0] <= lon1 + pad)
            & (lonlat[:, 1] >= lat0 - pad)
            & (lonlat[:, 1] <= lat1 + pad)
        )
        picked = np.unique(way_of_point[inside])
        return [lonlat[ways.offsets[w] : ways.offsets[w + 1]] for w in picked], classes[picked]

    data = {}
    chosen = {}
    for corridor in CORRIDORS:
        ids = _overlay_trips(sample["corridors"][corridor.name], sample, per_trip, args.trips)
        chosen[corridor.name] = ids
        trips = {t: sample["trips"][t] for t in ids}
        data[corridor.name] = corridor_data(
            corridor.name, corridor.bbox, trips, methods, *rail_in(corridor.bbox)
        )
    hits = json.loads(args.hits.read_text()) if args.hits else {}
    for method, items in hits.items():
        for k, hit in enumerate(items):
            lon, lat = hit["lon"], hit["lat"]
            bbox = (lon - 0.0075, lat - 0.0035, lon + 0.0075, lat + 0.0035)
            name = f"hit-{method}-{k:02d}"
            trips = {hit["trip"]: sample["trips"][hit["trip"]]}
            title = f"{name}: {method} off-relation run of {round(hit['length_m'])} m"
            page = corridor_data(title, bbox, trips, methods, *rail_in(bbox))
            page["center"], page["zoom"] = [lon, lat], 17
            data[name] = page
    write_preview(args.out, data)
    _report("overlay", started, {"pages": len(data), "trips": chosen})


def cmd_stop_outliers(args: argparse.Namespace) -> None:
    """Stops farther than the limit from each method's shape, and whether the other agrees."""
    from collections import Counter  # noqa: PLC0415

    from shapely import LineString, points  # noqa: PLC0415

    from gerlines_rail_graph.project import to_xy  # noqa: PLC0415

    sample = json.loads(args.sample.read_text())
    first, second = args.method
    shapes = {}
    for spec in args.method:
        name, path = spec.split("=", 1)
        shapes[name] = json.loads(Path(path).read_text())
    a_name, b_name = first.split("=")[0], second.split("=")[0]
    total = 0
    counts: Counter[str] = Counter()
    only_a: Counter[str] = Counter()
    only_b: Counter[str] = Counter()
    for t in sample["national"]:
        trip = sample["trips"][t]
        a_raw, b_raw = shapes[a_name].get(t), shapes[b_name].get(t)
        if not a_raw or not b_raw:
            continue
        lonlat = np.array([[s[2], s[3]] for s in trip["stops"]])
        stops = points(to_xy(lonlat[:, 0], lonlat[:, 1]))
        far = {}
        for name, raw in ((a_name, a_raw), (b_name, b_raw)):
            arr = np.array(raw)
            far[name] = LineString(to_xy(arr[:, 0], arr[:, 1])).distance(stops) > args.limit
        total += len(stops)
        counts[a_name] += int(far[a_name].sum())
        counts[b_name] += int(far[b_name].sum())
        counts["both"] += int((far[a_name] & far[b_name]).sum())
        for k in np.flatnonzero(far[a_name] & ~far[b_name]):
            only_a[trip["stops"][k][1]] += 1
        for k in np.flatnonzero(far[b_name] & ~far[a_name]):
            only_b[trip["stops"][k][1]] += 1
    print(
        json.dumps(
            {
                "stops": total,
                "over_limit": dict(counts),
                f"only_{a_name}": sum(only_a.values()),
                f"only_{b_name}": sum(only_b.values()),
                f"top_only_{a_name}": only_a.most_common(12),
                f"top_only_{b_name}": only_b.most_common(12),
            },
            ensure_ascii=False,
        )
    )


def cmd_report(args: argparse.Namespace) -> None:
    from gerlines_rail_graph.report import table  # noqa: PLC0415

    results = json.loads(args.results.read_text())
    summary = sorted(g for g in results if g.startswith("all:"))
    corridors = sorted(g for g in results if g.startswith("corridor:"))
    strata = sorted(g for g in results if g not in summary and g not in corridors)
    print("## Stratified sample, domestic and cross-border\n\n" + table(results, summary))
    print("\n## By category and scope\n\n" + table(results, strata))
    print("\n## Corridors\n\n" + table(results, corridors))


COMMANDS: dict[str, Callable[[argparse.Namespace], None]] = {
    "report": cmd_report,
    "stop-outliers": cmd_stop_outliers,
    "gate": cmd_gate,
    "hits": cmd_hits,
    "legs": cmd_legs,
    "overlay": cmd_overlay,
    "osm": cmd_osm,
    "sample": cmd_sample,
    "shapes": cmd_shapes,
    "motis": cmd_motis,
    "evaluate": cmd_evaluate,
}


def build_parser() -> argparse.ArgumentParser:  # noqa: PLR0915
    parser = argparse.ArgumentParser(prog="gerlines-rail-graph")
    sub = parser.add_subparsers(dest="command", required=True)

    osm = sub.add_parser(
        "osm", help="cache rail ways of the rail extract and route classes of the full extract"
    )
    osm.add_argument("--rail-pbf", type=Path, required=True)
    osm.add_argument(
        "--full-pbf",
        type=Path,
        action="append",
        required=True,
        help="extract with the route relations; repeat it for the neighbours' corridor",
    )
    osm.add_argument("--out", type=Path, required=True)

    sample = sub.add_parser("sample", help="pick corridor and national trips running on one day")
    sample.add_argument("--gtfs", type=Path, required=True)
    sample.add_argument("--validation-report", type=Path)
    sample.add_argument("--date", required=True)
    sample.add_argument("--outline", type=Path, required=True)
    sample.add_argument("--per-category", type=int, default=120)
    sample.add_argument("--per-corridor", type=int, default=4)
    sample.add_argument("--seed", type=int, default=20261027)
    sample.add_argument("--out", type=Path, required=True)

    shapes = sub.add_parser("shapes", help="shapes of the sample trips from a GTFS zip or folder")
    shapes.add_argument("--sample", type=Path, required=True)
    shapes.add_argument("--feed", type=Path, required=True)
    shapes.add_argument("--out", type=Path, required=True)

    motis = sub.add_parser("motis", help="trip geometry of the sample trips from a MOTIS server")
    motis.add_argument("--sample", type=Path, required=True)
    motis.add_argument("--base-url", default="http://127.0.0.1:8090")
    motis.add_argument("--tag", default="de")
    motis.add_argument("--out", type=Path, required=True)

    evaluate = sub.add_parser("evaluate", help="metrics per method, corridor and national sample")
    evaluate.add_argument("--sample", type=Path, required=True)
    evaluate.add_argument("--osm", type=Path, required=True)
    evaluate.add_argument("--outline", type=Path, required=True)
    evaluate.add_argument("--method", action="append", required=True, help="name=shapes.json")
    evaluate.add_argument("--out", type=Path, required=True)

    outliers = sub.add_parser("stop-outliers", help="stops far from two methods' shapes")
    outliers.add_argument("--sample", type=Path, required=True)
    outliers.add_argument(
        "--method", action="append", required=True, help="name=shapes.json, twice"
    )
    outliers.add_argument("--limit", type=float, default=80.0)

    gate = sub.add_parser("gate", help="QA gate and per-pattern method choice on per-trip.json")
    gate.add_argument("--sample", type=Path, required=True)
    gate.add_argument("--per-trip", type=Path, required=True)
    gate.add_argument("--out", type=Path, required=True)

    legs = sub.add_parser("legs", help="domestic legs much longer than their rail path")
    legs.add_argument("--sample", type=Path, required=True)
    legs.add_argument("--shapes", type=Path, required=True)
    legs.add_argument("--osm", type=Path, required=True)
    legs.add_argument("--outline", type=Path, required=True)
    legs.add_argument("--extra", type=float, default=300.0)
    legs.add_argument("--top", type=int, default=12)

    hits = sub.add_parser(
        "hits", help="random off-relation runs per method for the precision check"
    )
    hits.add_argument("--sample", type=Path, required=True)
    hits.add_argument("--per-trip", type=Path, required=True)
    hits.add_argument("--methods", default="motis,pfaedle")
    hits.add_argument("--count", type=int, default=20)
    hits.add_argument("--seed", type=int, default=20261025)
    hits.add_argument("--out", type=Path, required=True)

    report = sub.add_parser("report", help="markdown tables of results.json")
    report.add_argument("--results", type=Path, required=True)

    overlay = sub.add_parser("overlay", help="write the overlay preview folder per corridor")
    overlay.add_argument("--sample", type=Path, required=True)
    overlay.add_argument("--osm", type=Path, required=True)
    overlay.add_argument("--per-trip", type=Path, required=True)
    overlay.add_argument("--method", action="append", required=True, help="name=shapes.json")
    overlay.add_argument("--trips", type=int, default=3)
    overlay.add_argument("--hits", type=Path, help="hits.json from the hits command")
    overlay.add_argument("--out", type=Path, required=True)
    COMMANDS.update(register(sub))
    COMMANDS.update(register_shapes(sub))
    COMMANDS.update(register_neighbours(sub))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    COMMANDS[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
