"""Canonical categories (architecture section 9) from GTFS route types, line names and agencies.

The rules run in a fixed order: rail replacement buses first, then the line name prefix, then
agency rules for names that say nothing (``DRF``, empty or numeric names), then the extended
route type. A rail route that no rule explains falls back to its route type with the rule
``fallback:<type>``; the importer reports every such route so a rule can be added.
"""

import re
from dataclasses import dataclass
from enum import StrEnum


class Category(StrEnum):
    HSR = "hsr"
    LD = "ld"
    NIGHT = "night"
    RFAST = "rfast"
    REG = "reg"
    SBAHN = "sbahn"
    URBAN = "urban"
    BUS = "bus"
    OTHER = "other"


TRAIN_CATEGORIES = frozenset(
    {Category.HSR, Category.LD, Category.NIGHT, Category.RFAST, Category.REG, Category.SBAHN}
)

ENRICHED_ROUTE_TYPE: dict[Category, int] = {
    Category.HSR: 101,
    Category.LD: 102,
    Category.NIGHT: 105,
    Category.RFAST: 106,
    Category.REG: 106,
    Category.SBAHN: 109,
}
RAIL_REPLACEMENT_BUS_ROUTE_TYPE = 714

FALLBACK_PREFIX = "fallback:"


@dataclass(frozen=True, slots=True)
class Classification:
    category: Category | None
    rule: str

    @property
    def is_fallback(self) -> bool:
        return self.rule.startswith(FALLBACK_PREFIX)

    @property
    def is_train(self) -> bool:
        return self.category in TRAIN_CATEGORIES


_NAME_PREFIX: dict[str, Category] = {
    **dict.fromkeys(["ICE", "TGV", "THA", "RJX", "ES", "EST", "FR"], Category.HSR),
    **dict.fromkeys(["IC", "EC", "ECE", "ECM", "FLX", "RJ", "D"], Category.LD),
    **dict.fromkeys(["EN", "NJ"], Category.NIGHT),
    **dict.fromkeys(
        ["RE", "IRE", "MEX", "FEX", "RX", "REX", "HBX", "EX", "E", "IR", "SP", "RR"],
        Category.RFAST,
    ),
    **dict.fromkeys(["S", "RS"], Category.SBAHN),
    **dict.fromkeys(
        [
            "RB", "R", "OS", "P", "T", "L", "U", "A", "C", "CD", "RT", "DRB", "DPN", "DWE",
            "HSB", "ITB", "KJ", "KTB", "MBB", "MSB", "PE", "SAB", "SWB", "WIP", "LINIE",
            "CHIEMSEE", "CHIEMSEEBAHN", "KUCKUCKSBÄHNEL", "LÖSSNITZGRUNDBAHN",
            "WEISSERITZTALBAHN",
        ],
        Category.REG,
    ),
}  # fmt: skip

_NIGHT_LINE = re.compile(r"^\d+N$")
_REPLACEMENT_BUS = re.compile(r"^SEV(\b|\d|\s)", re.IGNORECASE)
_PREFIX = re.compile(r"^([^\W\d_]+)")
_NUMERIC = re.compile(r"^\d+$")

_AGENCY_RULES: tuple[tuple[re.Pattern[str], Category], ...] = (
    (re.compile(r"european sleeper|^nachtzug|nightjet", re.IGNORECASE), Category.NIGHT),
    (re.compile(r"leo express|westbahn|bahntouristikexpress", re.IGNORECASE), Category.LD),
    (re.compile(r"autozug sylt|gaildorf-untergröningen", re.IGNORECASE), Category.REG),
    (re.compile(r"^regionalbuslinien$|^omnibus$", re.IGNORECASE), Category.BUS),
)

_FOREIGN_LONG_DISTANCE = re.compile(
    r"^(Ceske Drahy|České dráhy|ZSSK|Österreichische Bundesbahnen|MAV)$", re.IGNORECASE
)
_DB_EC_LINES = frozenset({"27", "89"})

_TYPE_DEFAULT: dict[int, Category] = {
    100: Category.REG,
    101: Category.HSR,
    102: Category.LD,
    103: Category.RFAST,
    104: Category.LD,
    105: Category.NIGHT,
    106: Category.REG,
    107: Category.REG,
    108: Category.REG,
    109: Category.SBAHN,
    110: Category.REG,
    111: Category.REG,
    112: Category.REG,
    113: Category.REG,
    114: Category.LD,
    115: Category.REG,
    116: Category.REG,
    117: Category.REG,
    2: Category.REG,
}


def is_rail_type(route_type: int) -> bool:
    return route_type == 2 or 100 <= route_type <= 117


def _non_rail(route_type: int) -> Category | None:
    if route_type in {0, 1, 5, 7, 12} or 400 <= route_type <= 405 or 900 <= route_type <= 906:
        return Category.URBAN
    if route_type in {3, 11, 800} or 200 <= route_type <= 209 or 700 <= route_type <= 716:
        return Category.BUS
    if (
        route_type in {4, 6}
        or 1000 <= route_type <= 1307
        or 1400 <= route_type <= 1507
        or route_type in {1551, 1700, 1702}
    ):
        return Category.OTHER
    return None


def name_prefix(short_name: str) -> str:
    match = _PREFIX.match(short_name.strip())
    return match.group(1).upper().replace("ß", "SS") if match else ""


def classify(route_type: int, short_name: str, agency_name: str) -> Classification:
    if not is_rail_type(route_type):
        category = _non_rail(route_type)
        rule = f"type:{route_type}" if category is not None else f"unmapped-type:{route_type}"
        return Classification(category, rule)
    name = short_name.strip()
    return (
        _by_name(name)
        or _by_numeric_line(route_type, name, agency_name)
        or _by_agency(agency_name)
        or _by_type(route_type, name)
    )


def _by_name(name: str) -> Classification | None:
    if _REPLACEMENT_BUS.match(name):
        return Classification(Category.BUS, "name:SEV")
    if _NIGHT_LINE.match(name):
        return Classification(Category.NIGHT, "name:night-line")
    prefix = name_prefix(name)
    if prefix in _NAME_PREFIX:
        return Classification(_NAME_PREFIX[prefix], f"name:{prefix}")
    return None


def _by_numeric_line(route_type: int, name: str, agency_name: str) -> Classification | None:
    """Numeric DB line numbers on route type 101 that are EuroCity or Railjet lines, not ICE.

    DELFI files ČD, ZSSK, ÖBB and MÁV lines and DB lines 27 (Hamburg, Berlin, Prague, Budapest)
    and 89 (Munich, Innsbruck, Verona, Venice) as high speed; their trains are EC and RJ.
    """
    if route_type != 101 or not _NUMERIC.match(name):
        return None
    if _FOREIGN_LONG_DISTANCE.match(agency_name):
        return Classification(Category.LD, "line:foreign-numeric-101")
    if agency_name.startswith("DB Fernverkehr") and name in _DB_EC_LINES:
        return Classification(Category.LD, "line:db-ec-27-89")
    return None


def _by_agency(agency_name: str) -> Classification | None:
    for pattern, category in _AGENCY_RULES:
        if pattern.search(agency_name):
            return Classification(category, f"agency:{pattern.pattern}")
    return None


def _by_type(route_type: int, name: str) -> Classification:
    prefix = name_prefix(name)
    default = _TYPE_DEFAULT[route_type]
    if (
        not name
        or _NUMERIC.match(name)
        or prefix == "LEER"
        or (route_type == 109 and prefix == "N")
    ):
        return Classification(default, f"type:{route_type}")
    return Classification(default, f"{FALLBACK_PREFIX}{route_type}")
