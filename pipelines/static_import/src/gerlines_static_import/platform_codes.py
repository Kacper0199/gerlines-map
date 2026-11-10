"""Per feed recheck of the district stop numbers that `normalizePlatform` drops.

The rule in `@gerlines/schema/platform` (`STOP_NUMBER_FROM`) was measured on the DELFI feed of
2026-10-19 against DB IRIS station plans: VRS districts publish stop numbers from 70 up and OWL
districts 9 before the track. These floors mirror it; a load counts the numeric platform codes of
each district so a changed scheme shows in `load-report.json`.
"""

import re
from collections import Counter
from collections.abc import Iterable

from gerlines_static_import.stops import Point

VRS_DISTRICTS = dict.fromkeys(
    ("05314", "05315", "05316", "05362", "05366", "05374", "05378", "05382"), 70
)
OWL_DISTRICTS = dict.fromkeys(("05711", "05754", "05758", "05762", "05766", "05770", "05774"), 90)
STOP_NUMBER_FROM = VRS_DISTRICTS | OWL_DISTRICTS
UNLISTED_FLOOR = 70
UNLISTED_WARN_AT = 5
BELOW_FLOOR_WARN_SHARE = 0.25
_DISTRICT = re.compile(r"^[a-z]{2}:(\d{5}):")
_NUMERIC = re.compile(r"^\d+$")
_RULE = "STOP_NUMBER_FROM in @gerlines/schema/platform"


def stop_number_check(points: Iterable[Point]) -> dict[str, object]:
    """Numeric platform codes per listed district against its floor, and unlisted districts with
    codes of 70 and above. It warns when over a quarter of a listed district's numeric codes lie
    under its floor (on 2026-10-19 at most 1 of 20 did: Köln Worringen 11, Kerpen Horrem 37,
    Leopoldstal 2) and when an unlisted district has 5 or more of 70 and above (on 2026-10-19 the
    MVV S-Bahn 09162 with 56, the Märkischer Kreis 05962, Bingen 07339 and Hanau 06435)."""
    numeric: Counter[str] = Counter()
    below: Counter[str] = Counter()
    unlisted: Counter[str] = Counter()
    for point in points:
        code = (point.platform_code or "").strip()
        match = _DISTRICT.match(point.dhid or "")
        if match is None or not _NUMERIC.match(code):
            continue
        district = match.group(1)
        floor = STOP_NUMBER_FROM.get(district)
        if floor is None:
            if int(code) >= UNLISTED_FLOOR:
                unlisted[district] += 1
            continue
        numeric[district] += 1
        if int(code) < floor:
            below[district] += 1
    warnings = [
        f"district {district} has {count} numeric platform codes under its stop number floor "
        f"{STOP_NUMBER_FROM[district]}: it may have changed its scheme, revisit {_RULE}"
        for district, count in sorted(below.items())
        if count > BELOW_FLOOR_WARN_SHARE * numeric[district]
    ] + [
        f"district {district} has {count} numeric platform codes of {UNLISTED_FLOOR} and above: "
        f"they may be stop numbers, check them against IRIS station plans and {_RULE}"
        for district, count in unlisted.most_common()
        if count >= UNLISTED_WARN_AT
    ]
    return {
        "districts": {
            district: {
                "floor": STOP_NUMBER_FROM[district],
                "numeric": numeric[district],
                "below_floor": below[district],
            }
            for district in sorted(numeric)
        },
        "unlisted_70_and_above": dict(unlisted.most_common()),
        "warnings": warnings,
    }
