"""One stop place identity per station across feed versions.

DELFI's weekly feeds sometimes give a station another id: the DHID under another district key
(``de:03159:33817`` and ``de:03152:33817`` Göttingen), a renumbered DHID at the same point
(``de:08231:3996`` to ``de:08231:332`` Weißenstein), a reissued Swiss IFOPT (``ch:23005:826`` to
``ch:1:sloid:16764`` Riehen) or a DHID for a place that had none. A place whose id is neither in
``id_map`` nor found by DHID would get a new UUID, and realtime, statistics and history of the
station would split at the rollover. ``resolve_identity`` gives such a place the stored identity
of the same station instead:

1. district twins in one feed (same country and station number, another district key, alike
   names within ``TWIN_MAX_M``) fold into one place;
2. reviewed overrides: ``same`` gives a place a stored identity, folding the place of the feed
   that holds it into it, ``separate`` keeps a pair apart and gives a place that an earlier load
   merged by mistake its own identity again;
3. the remaining new places take the stored place of the same station that no other place of
   the feed holds, in this order of rules: a district twin, the same EVA number carried by both
   ids (``000008010204`` and ``de:15087:8010204``) within ``EVA_CARRIED_MAX_M``, the same name
   within ``NAME_MAX_M``. Each stored place goes to one place, the best rule and the shortest
   distance first. EVA numbers of the spatial join are not a key: the join gives a bus station
   or a timing point next to a station that station's number.

Two places present in one feed never merge without an override (platform groups, S-Bahn tunnel
stations under a main station, neighbouring halts keep their places). Every match, fold and
refused candidate is returned for the review file. Places that end with one stop place id (an old
key that comes back next to the key a former load gave its place) fold into one place.
"""

import csv
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from gerlines_static_import.eva import differs_only_by_suffix, eva_in_stop_id, name_score
from gerlines_static_import.ids import canonical_id
from gerlines_static_import.spatial import GridIndex, distance_m
from gerlines_static_import.stops import Place, StopModel, fold_place, natural_key

TWIN_MAX_M = 300.0
EVA_CARRIED_MAX_M = 1000.0
NAME_MAX_M = 100.0
TWIN_MIN_SCORE = 0.8
DECISIONS = frozenset({"same", "separate"})
RULES = ("override", "dhid_district", "eva", "name_distance")
SAME_IDENTITY = "same_identity"

_DHID = re.compile(r"^([a-z]{2}):([0-9]{5}):([0-9A-Za-z_]+)$")
_GERMAN = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
_WORD = re.compile(r"[a-z0-9]+")
_REPLACE = {"hauptbahnhof": "hbf", "bahnhof": "bf", "bhf": "bf", "sankt": "st"}
_DROP = frozenset({"bf"})
_STATION_WORDS = frozenset({"bahnhof", "bhf", "bf"})


@dataclass(frozen=True, slots=True)
class StoredPlace:
    """A stop place already in the database, with the DELFI keys ``id_map`` maps to it."""

    stop_place_id: UUID
    name: str
    lat: float | None
    lon: float | None
    dhid: str | None
    ifopt: str | None
    eva: int | None
    keys: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Override:
    key: str
    stored: str
    decision: str
    reason: str


class OverrideError(ValueError):
    """An override row is malformed or names a stop place that is not stored."""


@dataclass(frozen=True, slots=True)
class IdentityMatch:
    action: str
    kind: str
    change: str
    key: str
    name: str
    stop_place_id: UUID | None
    stored_keys: tuple[str, ...]
    stored_name: str
    distance_m: float | None
    note: str = ""


@dataclass(slots=True)
class IdentityResult:
    matches: list[IdentityMatch] = field(default_factory=list)

    def counts(self) -> dict[str, object]:
        taken = [m for m in self.matches if m.action in {"reused", "folded"}]
        return {
            "reused": sum(m.action == "reused" for m in self.matches),
            "folded": sum(m.action == "folded" for m in self.matches),
            "refused": sum(m.action == "refused" for m in self.matches),
            "separated": sum(m.action == "separated" for m in self.matches),
            "review": sum(m.action == "review" for m in self.matches),
            "skipped": sum(m.action == "skipped" for m in self.matches),
            "by_kind": dict(sorted(Counter(m.kind for m in taken).items())),
            "by_change": dict(sorted(Counter(m.change for m in taken).items())),
        }


def _folded_words(name: str) -> list[str]:
    folded = (
        unicodedata.normalize("NFKD", name.lower().translate(_GERMAN))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    return _WORD.findall(folded)


def identity_tokens(name: str) -> tuple[str, ...]:
    """Words of a name for identity: folded case and umlauts, Bahnhof and Bf dropped, sorted.

    Unlike the EVA join's tokens this keeps S, U, ZOB, tief and other qualifiers, which tell a
    bus station or a tunnel station from the station it lies next to.
    """
    words = (_REPLACE.get(word, word) for word in _folded_words(name))
    return tuple(sorted(word for word in words if word not in _DROP))


def _station_word_differs(a: str, b: str) -> bool:
    """The names agree only once Bahnhof, Bhf and Bf are set aside (X Bahnhof bus bay, X Bf)."""
    return set(_folded_words(a)) & _STATION_WORDS != set(_folded_words(b)) & _STATION_WORDS


def _same_name(a: str, b: str) -> bool:
    return identity_tokens(a) == identity_tokens(b)


def _alike(a: str, b: str, min_score: float) -> bool:
    return _same_name(a, b) or (
        name_score(a, b) >= min_score and not differs_only_by_suffix(a, b)
        and set(identity_tokens(a)) & set(identity_tokens(b)) != set()
    )  # fmt: skip


def _district_twins(a: str | None, b: str | None) -> bool:
    left = _DHID.match(a) if a else None
    right = _DHID.match(b) if b else None
    if left is None or right is None:
        return False
    return (
        left.group(1) == right.group(1)
        and left.group(3) == right.group(3)
        and left.group(2) != right.group(2)
    )


def _distance(a: Place | StoredPlace, b: Place | StoredPlace) -> float | None:
    if a.lat is None or a.lon is None or b.lat is None or b.lon is None:
        return None
    return distance_m(a.lat, a.lon, b.lat, b.lon)


def _change(place: Place, stored: StoredPlace) -> str:
    if place.dhid and stored.dhid:
        return "dhid_district" if _district_twins(place.dhid, stored.dhid) else "dhid_renumbered"
    if place.ifopt and stored.ifopt:
        return "ifopt_reissued"
    if not stored.dhid and not stored.ifopt:
        return "id_assigned" if place.dhid or place.ifopt else "lone_key_changed"
    return "id_changed"


def _carried_eva(keys: Iterable[str]) -> set[int]:
    return {eva for eva in (eva_in_stop_id(key) for key in keys) if eva is not None}


def _rule(place: Place, stored: StoredPlace) -> tuple[int, float] | None:
    """The rule that makes ``stored`` the same station as ``place`` and its distance, if any."""
    distance = _distance(place, stored)
    if distance is None:
        return None
    if (
        distance <= TWIN_MAX_M
        and _district_twins(place.dhid, stored.dhid)
        and _alike(place.name, stored.name, TWIN_MIN_SCORE)
    ):
        return RULES.index("dhid_district"), distance
    carried = _carried_eva([place.key]) & _carried_eva(stored.keys)
    if carried and distance <= EVA_CARRIED_MAX_M:
        return RULES.index("eva"), distance
    if distance <= NAME_MAX_M and _same_name(place.name, stored.name):
        return RULES.index("name_distance"), distance
    return None


def _match(  # noqa: PLR0913
    action: str,
    kind: str,
    place: Place,
    stored: StoredPlace,
    *,
    distance: float | None,
    note: str = "",
) -> IdentityMatch:
    return IdentityMatch(
        action=action,
        kind=kind,
        change=_change(place, stored),
        key=place.key,
        name=place.name,
        stop_place_id=stored.stop_place_id,
        stored_keys=stored.keys,
        stored_name=stored.name,
        distance_m=round(distance, 1) if distance is not None else None,
        note=note,
    )


def _as_stored(place: Place) -> StoredPlace:
    if place.canonical is None:
        msg = f"place {place.key} has no canonical id yet; run assign_canonical_ids first"
        raise ValueError(msg)
    return StoredPlace(
        place.canonical, place.name, place.lat, place.lon, place.dhid, place.ifopt, place.eva,
        (place.key,),
    )  # fmt: skip


def _point_counts(model: StopModel) -> Counter[str]:
    return Counter(point.place_key for point in model.points.values())


def _fold_twins(
    model: StopModel, stored_by_id: dict[UUID, StoredPlace], result: IdentityResult
) -> None:
    by_station: dict[tuple[str, str], list[Place]] = {}
    for place in model.places.values():
        found = _DHID.match(place.dhid) if place.dhid else None
        if found:
            by_station.setdefault((found.group(1), found.group(3)), []).append(place)
    points = _point_counts(model)
    for group in by_station.values():
        if len(group) < 2:
            continue
        group.sort(
            key=lambda p: (p.canonical not in stored_by_id, p.synthesised, -points[p.key], p.key)
        )
        target = group[0]
        for place in group[1:]:
            distance = _distance(place, target)
            if (
                distance is None
                or distance > TWIN_MAX_M
                or not _alike(place.name, target.name, TWIN_MIN_SCORE)
            ):
                continue
            result.matches.append(
                _match("folded", "dhid_district", place, _as_stored(target), distance=distance)
            )
            abandoned = stored_by_id.get(place.canonical) if place.canonical else None
            if abandoned is not None and abandoned.stop_place_id != target.canonical:
                result.matches.append(
                    _match(
                        "review",
                        "dhid_district",
                        place,
                        abandoned,
                        distance=_distance(place, abandoned),
                        note=(
                            f"both stored: points of {abandoned.stop_place_id} move to"
                            f" {target.canonical}, id_map keeps {place.key} on"
                            f" {abandoned.stop_place_id}"
                        ),
                    )
                )
            fold_place(model, place, target)


def _fold_same_identity(model: StopModel, result: IdentityResult) -> None:
    """Fold places with one stop place id, such as an old key back next to its new one."""
    by_id: dict[UUID, list[Place]] = {}
    for place in model.places.values():
        if place.canonical is not None:
            by_id.setdefault(place.canonical, []).append(place)
    points = _point_counts(model)
    for group in by_id.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda p: (p.synthesised, -points[p.key], p.key))
        target = group[0]
        for place in group[1:]:
            result.matches.append(
                _match(
                    "folded",
                    SAME_IDENTITY,
                    place,
                    _as_stored(target),
                    distance=_distance(place, target),
                    note=f"both keys map to {target.canonical}",
                )
            )
            fold_place(model, place, target)


def _find_stored(reference: str, stored: Sequence[StoredPlace]) -> StoredPlace | None:
    return next(
        (
            candidate
            for candidate in stored
            if reference in candidate.keys
            or reference in {candidate.dhid, candidate.ifopt}
            or reference == str(candidate.stop_place_id)
        ),
        None,
    )


def _resolve_stored(reference: str, stored: Sequence[StoredPlace]) -> StoredPlace:
    found = _find_stored(reference, stored)
    if found is not None:
        return found
    msg = f"override names no stored stop place {reference}"
    raise OverrideError(msg)


def _skipped(override: Override, model: StopModel, stored: Sequence[StoredPlace]) -> IdentityMatch:
    target = _find_stored(override.stored, stored)
    folded = model.merged.get(override.key)
    note = f"{override.decision}: " + (
        f"key folded into {folded}" if folded else "key not in this feed"
    )
    if target is None:
        note += f", no stored stop place {override.stored}"
    return IdentityMatch(
        action="skipped",
        kind="override",
        change="",
        key=override.key,
        name="",
        stop_place_id=target.stop_place_id if target else None,
        stored_keys=target.keys if target else (),
        stored_name=target.name if target else "",
        distance_m=None,
        note=note,
    )


def _apply_overrides(
    model: StopModel,
    stored: Sequence[StoredPlace],
    overrides: Sequence[Override],
    result: IdentityResult,
    source_id: str,
) -> set[tuple[str, UUID]]:
    separate: set[tuple[str, UUID]] = set()
    for override in overrides:
        place = model.places.get(override.key)
        if place is None:
            result.matches.append(_skipped(override, model, stored))
            continue
        target = _resolve_stored(override.stored, stored)
        if override.decision == "separate":
            separate.add((place.key, target.stop_place_id))
            if place.canonical == target.stop_place_id:
                place.canonical = canonical_id(
                    "stop_place", natural_key(source_id, place.key, place.dhid, place.ifopt)
                )
                result.matches.append(
                    _match(
                        "separated",
                        "override",
                        place,
                        target,
                        distance=_distance(place, target),
                        note="own identity again",
                    )
                )
            continue
        holder = next(
            (
                p
                for p in model.places.values()
                if p.canonical == target.stop_place_id and p.key != place.key
            ),
            None,
        )
        place.canonical = target.stop_place_id
        if holder is None:
            result.matches.append(
                _match("reused", "override", place, target, distance=_distance(place, target))
            )
            continue
        result.matches.append(
            _match("folded", "override", place, target, distance=_distance(place, target))
        )
        fold_place(model, holder, place)
    return separate


def resolve_identity(
    model: StopModel,
    stored: Iterable[StoredPlace],
    overrides: Sequence[Override],
    *,
    source_id: str,
) -> IdentityResult:
    """Give the new places of ``model`` the stored identity of the same station, in place.

    Runs after ``assign_canonical_ids``; places it folds stay mapped in ``model.merged``.
    """
    stored_list = list(stored)
    stored_by_id = {s.stop_place_id: s for s in stored_list}
    stored_ids = set(stored_by_id)
    result = IdentityResult()
    _fold_twins(model, stored_by_id, result)
    separate = _apply_overrides(model, stored_list, overrides, result, source_id)
    holders = {p.canonical: p.key for p in model.places.values() if p.canonical in stored_ids}
    grid = GridIndex(stored_list)
    pairs: list[tuple[int, float, str, StoredPlace]] = []
    for place in model.places.values():
        if place.canonical in stored_ids or place.lat is None or place.lon is None:
            continue
        for candidate in grid.near(place.lat, place.lon):
            rule = _rule(place, candidate)
            if rule is not None:
                pairs.append((rule[0], rule[1], place.key, candidate))
    pairs.sort(key=lambda item: (item[0], item[1], item[2], str(item[3].stop_place_id)))
    decided: set[str] = set()
    for rank, distance, key, candidate in pairs:
        if key in decided:
            continue
        place = model.places[key]
        kind = RULES[rank]
        decided.add(key)
        if (key, candidate.stop_place_id) in separate:
            result.matches.append(
                _match(
                    "refused",
                    kind,
                    place,
                    candidate,
                    distance=distance,
                    note="separate by override",
                )
            )
            continue
        holder = holders.get(candidate.stop_place_id)
        if holder is not None:
            result.matches.append(
                _match(
                    "refused", kind, place, candidate, distance=distance, note=f"held by {holder}"
                )
            )
            continue
        place.canonical = candidate.stop_place_id
        holders[candidate.stop_place_id] = key
        result.matches.append(_match("reused", kind, place, candidate, distance=distance))
        if kind == "name_distance" and _station_word_differs(place.name, candidate.name):
            result.matches.append(
                _match(
                    "review",
                    kind,
                    place,
                    candidate,
                    distance=distance,
                    note="names agree only without Bahnhof or Bf: a bus stop at the station?",
                )
            )
    _fold_same_identity(model, result)
    return result


def read_overrides(path: Path | None) -> list[Override]:
    """Reviewed decisions: ``key,stored,decision,reason`` with decision ``same`` or ``separate``."""
    if path is None:
        return []
    if not path.exists():
        msg = f"place overrides {path} does not exist"
        raise OverrideError(msg)
    found = []
    with path.open(newline="", encoding="utf-8") as handle:
        for line, row in enumerate(csv.DictReader(handle), start=2):
            key = (row.get("key") or "").strip()
            target = (row.get("stored") or "").strip()
            decision = (row.get("decision") or "").strip()
            if not key or not target or decision not in DECISIONS:
                msg = f"{path} line {line}: key {key!r}, stored {target!r}, decision {decision!r}"
                raise OverrideError(msg)
            found.append(Override(key, target, decision, (row.get("reason") or "").strip()))
    return found


REVIEW_COLUMNS = (
    "action", "kind", "change", "key", "name", "stop_place_id", "stored_keys", "stored_name",
    "distance_m", "note",
)  # fmt: skip


def write_identity_review(path: Path, matches: Iterable[IdentityMatch]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(REVIEW_COLUMNS)
        for m in sorted(matches, key=lambda m: (m.action, m.kind, m.key)):
            writer.writerow(
                (
                    m.action,
                    m.kind,
                    m.change,
                    m.key,
                    m.name,
                    "" if m.stop_place_id is None else m.stop_place_id,
                    " ".join(m.stored_keys),
                    m.stored_name,
                    "" if m.distance_m is None else m.distance_m,
                    m.note,
                )
            )
