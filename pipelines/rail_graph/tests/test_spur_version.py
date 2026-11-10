import hashlib
import json

from gerlines_rail_graph import splice, spurs

CONSTANTS_AT_VERSION = {6: "5147dfa28e59af66e426f10331ea2f27ad499499355c83ff74b55361c5bc512d"}


def constants_hash() -> str:
    values = {
        f"spurs.{k}": v
        for k, v in vars(spurs).items()
        if k.isupper() and isinstance(v, int | float | str | tuple) and k != "SPUR_VERSION"
    }
    values |= {
        f"splice.{k}": v
        for k, v in vars(splice).items()
        if k.isupper() and isinstance(v, int | float | str)
    }
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def test_a_changed_spur_or_splice_constant_comes_with_a_spur_version_bump():
    assert CONSTANTS_AT_VERSION.get(spurs.SPUR_VERSION) == constants_hash(), (
        "spur or splice constants changed: bump SPUR_VERSION and record the new hash here"
    )
