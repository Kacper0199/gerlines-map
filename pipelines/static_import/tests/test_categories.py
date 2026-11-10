import csv
from pathlib import Path

import pytest

from gerlines_static_import.categories import (
    ENRICHED_ROUTE_TYPE,
    TRAIN_CATEGORIES,
    Category,
    classify,
    is_rail_type,
)

FIXTURE = Path(__file__).parent / "fixtures" / "delfi-2026-10-19-rail-routes.csv"


@pytest.mark.parametrize(
    ("route_type", "name", "agency", "expected"),
    [
        (101, "1", "DB Fernverkehr AG", Category.HSR),
        (101, "ICE", "SBB", Category.HSR),
        (101, "THA", "EUROSTAR", Category.HSR),
        (101, "82", "SNCF", Category.HSR),
        (101, "10", "DB Fernverkehr AG", Category.HSR),
        (101, "27", "DB Fernverkehr AG", Category.LD),
        (101, "89", "DB Fernverkehr AG", Category.LD),
        (101, "89", "Österreichische Bundesbahnen", Category.LD),
        (101, "27", "Ceske Drahy", Category.LD),
        (101, "27", "ZSSK", Category.LD),
        (102, "27", "DB Fernverkehr AG", Category.LD),
        (102, "RJX", "Österreichische Bundesbahnen", Category.HSR),
        (101, "RJ", "Ceske Drahy", Category.LD),
        (102, "FLX10", "FlixTrain-de", Category.LD),
        (102, "ECM", "Trenitalia", Category.LD),
        (106, "IC17", "DB Fernverkehr (Codesharing)", Category.LD),
        (102, "27N", "DB Fernverkehr AG", Category.NIGHT),
        (102, "91N", "Österreichische Bundesbahnen", Category.NIGHT),
        (102, "EN", "BahnTouristikExpress", Category.NIGHT),
        (102, "NJ", "SNCB", Category.NIGHT),
        (106, "DRF", "European Sleeper", Category.NIGHT),
        (106, "DRF", "Nachtzug", Category.NIGHT),
        (106, "DRF", "LEO Express", Category.LD),
        (106, "DRF", "WESTbahn", Category.LD),
        (101, "RE25", "vogtlandbahn - Die Länderbahn GmbH DLB", Category.RFAST),
        (106, "RE1", "DB Regio AG Nord", Category.RFAST),
        (106, "MEX", "EVB ELBE-WESER GmbH", Category.RFAST),
        (109, "FEX", "Albtal-Verkehrs-Gesellschaft", Category.RFAST),
        (106, "REX", "Österreichische Bundesbahnen", Category.RFAST),
        (106, "RB27", "DB Regio AG", Category.REG),
        (106, "U28", "Ceske Drahy", Category.REG),
        (2, "Lößnitzgrundbahn", "DB-Nahverkehr", Category.REG),
        (2, "CD 030", "CD", Category.REG),
        (109, "S1", "S-Bahn Hamburg", Category.SBAHN),
        (106, "S5", "DB Regio AG", Category.SBAHN),
        (2, "S3", "Nahreisezug", Category.SBAHN),
        (109, "N14", "THURBO", Category.SBAHN),
        (106, "RS1", "Südwestdeutsche Verkehrs-AG", Category.SBAHN),
        (109, "SEV3", "S-Bahn Hannover", Category.BUS),
        (3, "RE1", "DB Regio Mitte", Category.BUS),
        (700, "S1", "S-Bahn Berlin GmbH", Category.BUS),
        (0, "SC", "VAG - Stadtbahn", Category.URBAN),
        (400, "U2", "BVG", Category.URBAN),
        (1000, "F1", "Fähre", Category.OTHER),
    ],
)
def test_maps_known_traps(route_type: int, name: str, agency: str, expected: Category) -> None:
    result = classify(route_type, name, agency)
    assert result.category == expected
    assert not result.is_fallback


def test_unknown_rail_name_falls_back_loudly() -> None:
    result = classify(106, "XYZ9", "Neue Bahn")
    assert result.category == Category.REG
    assert result.is_fallback
    assert result.rule == "fallback:106"


def test_unknown_route_type_is_unmapped() -> None:
    result = classify(1600, "X", "Y")
    assert result.category is None
    assert result.rule == "unmapped-type:1600"


def test_every_train_category_has_an_enriched_route_type() -> None:
    assert set(ENRICHED_ROUTE_TYPE) == set(TRAIN_CATEGORIES)
    assert all(is_rail_type(value) for value in ENRICHED_ROUTE_TYPE.values())


def _fixture_rows() -> list[dict[str, str]]:
    with FIXTURE.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def test_fixture_covers_every_rail_route_combination_of_the_feed() -> None:
    rows = _fixture_rows()
    assert len(rows) == len(
        {(r["route_type"], r["route_short_name"], r["agency_name"]) for r in rows}
    )
    assert sum(int(r["routes"]) for r in rows) == 1161


def test_every_rail_route_combination_of_the_feed_maps_to_its_reviewed_category() -> None:
    mismatches = []
    fallbacks = []
    for row in _fixture_rows():
        result = classify(int(row["route_type"]), row["route_short_name"], row["agency_name"])
        if result.category is None or result.category.value != row["category"]:
            mismatches.append((row, result))
        if result.is_fallback:
            fallbacks.append(row)
    assert mismatches == []
    assert fallbacks == []
