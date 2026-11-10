"""Unit kind, traction and double deck of a vehicle series from its Wikidata classes.

A series item names its classes with ``P31`` and ``P279``; every ``P279`` ancestor of those
classes counts as well. ``CLASS_FACTS`` is our reading of the rail vehicle classes that say
something definite (an electric multiple unit is an EMU with electric traction). A series takes
a field only when all its classes agree; otherwise the field stays empty with the reason. A
``P930`` electrification type gives electric traction when no class names another traction.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from gerlines_catalog import wikidata
from gerlines_catalog.cache import ResearchCache
from gerlines_catalog.models import VehicleSeries


@dataclass(frozen=True, slots=True)
class ClassFact:
    label: str
    unit_kind: str | None = None
    traction: str | None = None
    double_deck: bool | None = None


CLASS_FACTS: Mapping[str, ClassFact] = {
    "Q483373": ClassFact("electric multiple unit", "emu", "electric"),
    "Q1567915": ClassFact("diesel multiple unit", "dmu", "diesel"),
    "Q10915943": ClassFact("diesel railcar", "dmu", "diesel"),
    "Q625151": ClassFact("electric locomotive", "locomotive", "electric"),
    "Q34336": ClassFact("diesel locomotive", "locomotive", "diesel"),
    "Q19842071": ClassFact("diesel-electric locomotive", "locomotive", "diesel"),
    "Q24294815": ClassFact("diesel-hydraulic locomotive", "locomotive", "diesel"),
    "Q93301": ClassFact("locomotive", "locomotive"),
    "Q1261849": ClassFact("hydrogen train", traction="hydrogen"),
    "Q1243337": ClassFact("bilevel rail car", double_deck=True),
    "Q2632308": ClassFact("double-decker vehicle", double_deck=True),
    "Q935330": ClassFact("push-pull train", "trainset"),
}
TRACTION_REFINES_ELECTRIC = frozenset({"hydrogen", "battery_electric"})
FIELDS = ("unit_kind", "traction", "double_deck")


@dataclass(slots=True)
class SeriesClasses:
    qid: str
    classes: set[str] = field(default_factory=set)
    electrification: set[str] = field(default_factory=set)


@dataclass(frozen=True, slots=True)
class Derived:
    values: dict[str, str | bool]
    reasons: dict[str, str]
    evidence: dict[str, list[str]]


def collect(
    class_rows: Iterable[Mapping[str, str]], ancestor_rows: Iterable[Mapping[str, str]]
) -> dict[str, SeriesClasses]:
    """Group flat rows of ``series_class_query`` and ``ancestor_query`` by series item."""
    ancestors: dict[str, set[str]] = defaultdict(set)
    for row in ancestor_rows:
        ancestors[wikidata.qid_of(row["item"])].add(wikidata.qid_of(row["class"]))
    series: dict[str, SeriesClasses] = {}
    for row in class_rows:
        qid = wikidata.qid_of(row["item"])
        entry = series.setdefault(qid, SeriesClasses(qid))
        value = wikidata.qid_of(row["class"])
        if row["via"] in {"P31", "P279"}:
            entry.classes |= {value, *ancestors.get(value, ())}
        elif row["via"] == "P930":
            entry.electrification.add(value)
    return series


def _agreed(found: dict[object, list[str]], name: str) -> tuple[object | None, str | None]:
    if len(found) == 1:
        return next(iter(found)), None
    if not found:
        return None, f"no Wikidata class of the item states its {name}"
    listed = "; ".join(f"{value} ({', '.join(labels)})" for value, labels in sorted(found.items()))
    return None, f"Wikidata classes disagree on the {name}: {listed}"


def derive(entry: SeriesClasses) -> Derived:
    """The fields the item's classes agree on, the reason for every other field, the classes."""
    found: dict[str, dict[object, list[str]]] = {name: defaultdict(list) for name in FIELDS}
    for qid in sorted(entry.classes):
        fact = CLASS_FACTS.get(qid)
        if fact is None:
            continue
        for name in FIELDS:
            value = getattr(fact, name)
            if value is not None:
                found[name][value].append(fact.label)
    tractions = found["traction"]
    if set(tractions) - {"electric"} <= TRACTION_REFINES_ELECTRIC and len(tractions) > 1:
        tractions.pop("electric", None)
    if not tractions and entry.electrification:
        tractions["electric"].append("P930 type of electrification")
    values: dict[str, str | bool] = {}
    reasons: dict[str, str] = {}
    evidence: dict[str, list[str]] = {}
    for name in FIELDS:
        value, reason = _agreed(found[name], name.replace("_", " "))
        if value is None:
            reasons[name] = reason or ""
        else:
            values[name] = value  # type: ignore[assignment]
            evidence[name] = sorted(found[name][value])
    if "double_deck" in reasons and not found["double_deck"]:
        reasons["double_deck"] = "no Wikidata class of the item says double deck or single deck"
    return Derived(values, reasons, evidence)


SERIES_CHUNK = 5
ANCESTOR_CHUNK = 3


def _flat(rows: Iterable[dict]) -> list[dict[str, str]]:
    return [{key: entry["value"] for key, entry in row.items()} for row in rows]


def fetch(cache: ResearchCache, qids: list[str]) -> dict[str, SeriesClasses]:
    """Run both class queries through the research cache in the chunks the seeds used."""
    class_rows: list[dict[str, str]] = []
    for start in range(0, len(qids), SERIES_CHUNK):
        query = wikidata.series_class_query(qids[start : start + SERIES_CHUNK])
        class_rows += _flat(wikidata.run(cache, "series-classes", query))
    direct = sorted(
        {wikidata.qid_of(r["class"]) for r in class_rows if r["via"] in {"P31", "P279"}}
    )
    ancestor_rows: list[dict[str, str]] = []
    for start in range(0, len(direct), ANCESTOR_CHUNK):
        query = wikidata.ancestor_query(direct[start : start + ANCESTOR_CHUNK])
        ancestor_rows += _flat(wikidata.run(cache, "series-ancestors", query))
    return collect(class_rows, ancestor_rows)


def disagreements(series: Iterable[VehicleSeries], derived: Mapping[str, Derived]) -> list[str]:
    """Seed fields cited to Wikidata whose value differs from what the classes give."""
    found: list[str] = []
    for row in series:
        result = derived.get(row.wikidata_qid or "")
        for name in FIELDS:
            if row.source_of(name) != "wikidata" or getattr(row, name) is None:
                continue
            raw = getattr(row, name)
            value = raw.value if hasattr(raw, "value") else raw
            expected = result.values.get(name) if result else None
            if value != expected:
                found.append(f"{row.series_id}: {name} is {value!r}, Wikidata gives {expected!r}")
    return found
