import pytest

from gerlines_backfill.categories import classify, line_name


@pytest.mark.parametrize(
    ("train_type", "line", "category", "rule"),
    [
        ("ICE", None, "hsr", "type:ICE"),
        ("TGV", None, "hsr", "type:TGV"),
        ("RJX", None, "hsr", "type:RJX"),
        ("IC", None, "ld", "type:IC"),
        ("EC", None, "ld", "type:EC"),
        ("ECE", None, "ld", "type:ECE"),
        ("FLX", "30", "ld", "type:FLX"),
        ("RJ", None, "ld", "type:RJ"),
        ("WB", None, "ld", "type:WB"),
        ("NJ", None, "night", "type:NJ"),
        ("EN", None, "night", "type:EN"),
        ("ES", None, "night", "type:ES"),
        ("RE", "1", "rfast", "type:RE"),
        ("MEX", "13", "rfast", "type:MEX"),
        ("FEX", None, "rfast", "type:FEX"),
        ("RB", "61", "reg", "type:RB"),
        ("S", "9", "sbahn", "type:S"),
        ("HLB", "RB45", "reg", "line:RB"),
        ("HLB", "RE99", "rfast", "line:RE"),
        ("SBB", "S62", "sbahn", "line:S"),
        ("NWB", "RS3", "sbahn", "line:RS"),
        ("erx", "RE83", "rfast", "line:RE"),
        (None, "RB82", "reg", "line:RB"),
        (None, "68", "reg", "fallback"),
        ("STB", "1", "reg", "fallback"),
        ("Bus", "S1", "bus", "bus:Bus"),
        ("Bus", "SEV", "bus", "bus:Bus"),
        ("EV", "SEV", "bus", "bus:EV"),
        ("RBUS", "6", "bus", "bus:RBUS"),
        ("RE", "SEV", "bus", "bus:SEV"),
        ("SEV", "BUS RE1", "bus", "bus:SEV"),
    ],
)
def test_classify_iris_train_types(
    train_type: str | None, line: str | None, category: str, rule: str
) -> None:
    assert classify(train_type, line) == (category, rule)


@pytest.mark.parametrize(
    ("train_type", "line", "expected"),
    [
        ("RB", "61", "RB61"),
        ("S", "5X", "S5X"),
        ("HLB", "RB45", "RB45"),
        ("MEX", "17a", "MEX17a"),
        ("ICE", None, None),
        (None, "68", "68"),
        ("STB", "1", "1"),
        ("Bus", "SEV", "SEV"),
        ("RE", " ", None),
    ],
)
def test_line_name_joins_product_and_number(
    train_type: str | None, line: str | None, expected: str | None
) -> None:
    assert line_name(train_type, line) == expected
