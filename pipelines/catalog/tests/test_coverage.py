from dataclasses import replace

from gerlines_catalog.coverage import (
    RouteDay,
    line_colour_coverage,
    line_key,
    operator_coverage,
    series_coverage,
)
from gerlines_catalog.models import SERIES_EXPLAINED_FIELDS, LineColour
from gerlines_catalog.seeds import read_catalog

from .conftest import CATALOG


def route(operator: str, name: str, trips: int, km: float, agency: str = "1") -> RouteDay:
    return RouteDay(f"r-{operator}-{name}", agency, operator, name, "reg", False, trips, km)


def test_line_key_ignores_spaces_and_case() -> None:
    assert line_key("RB 15") == line_key("rb15") == "RB15"
    assert line_key(None) == ""


def test_operator_shares_weight_trips_and_km() -> None:
    catalog = read_catalog(CATALOG)
    routes = [
        route("db-fernverkehr-ag", "ICE 1", 30, 3000.0),
        route("chemnitzer-modell", "C11", 10, 100.0),
        route("not-catalogued", "RB 1", 10, 900.0),
    ]
    result = operator_coverage(catalog, routes)
    assert result["operators_running"] == 3
    assert result["with_wikidata"]["operators"] == 1
    assert result["with_wikidata"]["trip_share"] == 0.6
    assert result["with_wikidata"]["train_km_share"] == 0.75
    reasons = {item["operator_id"]: item["reason"] for item in result["without_wikidata"]}
    assert reasons["not-catalogued"] == "not in the catalogue"
    assert "concept" in str(reasons["chemnitzer-modell"])


def test_line_colours_match_by_operator_or_agency() -> None:
    catalog = read_catalog(CATALOG)
    colour = LineColour(
        line_colour_id="x-rb-15",
        upstream_operator="x",
        line_name="RB 15",
        delfi_agency_key="77",
        operator_id="agilis",
        background_hex="#000000",
        text_hex="#ffffff",
        shape="rectangle",
        source="traewelling-line-colors",
    )
    catalog = replace(catalog, line_colours=[colour])
    routes = [
        route("agilis", "RB15", 4, 1.0),
        route("other", "RB 15", 2, 1.0, agency="77"),
        route("agilis", "RB16", 4, 1.0),
    ]
    result = line_colour_coverage(catalog, routes)
    assert result["all"]["matched_routes"] == 2
    assert result["all"]["trip_share"] == 0.6


def test_series_coverage_counts_per_priority() -> None:
    result = series_coverage(read_catalog(CATALOG))
    assert result["all"]["series"] == sum(result[p]["series"] for p in ("P1", "P2", "P3"))
    total = result["all"]["series"]
    for name in SERIES_EXPLAINED_FIELDS:
        filled = result["all"][f"with_{name}"]
        assert filled + result["all"]["missing_reasons"].get(name, 0) == total, name
