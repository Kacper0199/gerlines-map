"""Canonical categories (architecture section 9) from IRIS train types and line numbers.

IRIS names the product in ``tl.c`` (``ICE``, ``RB``, ``S``) or, for many private operators, the
operator brand (``HLB``, ``NWB``, ``erx``) with the product in the line number (``RB45``,
``RE83``). The rules run in order: rail replacement buses, a product train type, a product
prefix of the line number, then regional rail as the fallback.
"""

import re

PRODUCTS: dict[str, str] = {
    **dict.fromkeys(["ICE", "TGV", "RJX", "THA", "EST", "FR"], "hsr"),
    **dict.fromkeys(["IC", "EC", "ECE", "ECM", "FLX", "RJ", "WB", "D"], "ld"),
    **dict.fromkeys(["NJ", "EN", "ES"], "night"),
    **dict.fromkeys(["RE", "IRE", "MEX", "FEX", "REX", "RX", "HBX", "EX", "IR"], "rfast"),
    **dict.fromkeys(["S", "RS"], "sbahn"),
    **dict.fromkeys(["RB", "R", "RT", "OS", "A", "C", "L"], "reg"),
}
BUS_TYPES = frozenset({"BUS", "EV", "SEV", "RBUS", "RBBUS", "NWBEV"})
FALLBACK = ("reg", "fallback")

_LINE_PREFIX = re.compile(r"^([^\W\d_]+)")
_BUS_LINE = re.compile(r"^(SEV|BUS)\b", re.IGNORECASE)


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def classify(train_type: str | None, line: str | None) -> tuple[str, str]:
    kind = _clean(train_type)
    number = _clean(line)
    if kind is not None and kind.upper() in BUS_TYPES:
        return "bus", f"bus:{kind}"
    if number is not None and _BUS_LINE.match(number):
        return "bus", "bus:SEV"
    if kind is not None and kind.upper() in PRODUCTS:
        return PRODUCTS[kind.upper()], f"type:{kind}"
    if number is not None and (match := _LINE_PREFIX.match(number)):
        prefix = match.group(1).upper()
        if prefix in PRODUCTS:
            return PRODUCTS[prefix], f"line:{prefix}"
    return FALLBACK


def line_name(train_type: str | None, line: str | None) -> str | None:
    number = _clean(line)
    if number is None:
        return None
    kind = _clean(train_type)
    if number[0].isdigit() and kind is not None and kind.upper() in PRODUCTS:
        return f"{kind}{number}"
    return number
