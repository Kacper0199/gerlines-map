"""Checks of ``identical-bodies.yaml``: which series may be drawn with the model of another."""

from collections import Counter
from collections.abc import Collection, Mapping, Sequence

from gerlines_catalog.models import IdenticalBody

FILE = "identical-bodies.yaml"
OWN_WORD = "gerlines"
Cars = tuple[int | None, int | None]


def _row_problems(
    row: IdenticalBody, source_ids: Collection[str], series_ids: Collection[str]
) -> list[str]:
    name = f"{FILE} {row.series_id} -> {row.related_series_id}"
    found = [
        f"{name}: unknown series {series_id!r}"
        for series_id in (row.series_id, row.related_series_id)
        if series_id not in series_ids
    ]
    if row.series_id == row.related_series_id:
        found.append(f"{name}: a series is not related to itself")
    found.extend(
        f"{name}: unknown source {source!r}"
        for source in sorted(row.referenced_sources() - set(source_ids))
    )
    if row.verdict == "accepted" and OWN_WORD in row.referenced_sources():
        found.append(f"{name}: an accepted pair needs a source other than our own word")
    return found


def _cars_problem(
    name: str, row: IdenticalBody, formations: Mapping[str, int], cars: Mapping[str, Cars]
) -> str | None:
    shown = formations.get(row.related_series_id)
    if shown is None:
        return None
    low, high = cars.get(row.series_id, (None, None))
    if low is None or high is None:
        return (
            f"{name}: cars_min and cars_max of {row.series_id!r} are unknown, "
            "the car count cannot be checked"
        )
    if not low <= shown <= high:
        return (
            f"{name}: the model of {row.related_series_id!r} has {shown} cars, "
            f"{row.series_id!r} has {low} to {high}"
        )
    return None


def _accepted_problems(
    accepted: Sequence[IdenticalBody], formations: Mapping[str, int], cars: Mapping[str, Cars]
) -> list[str]:
    mapped = Counter(row.series_id for row in accepted)
    found = [
        f"{FILE} {series_id!r} appears in two accepted rows"
        for series_id, count in mapped.items()
        if count > 1
    ]
    for row in accepted:
        name = f"{FILE} {row.series_id} -> {row.related_series_id}"
        if row.related_series_id not in formations:
            found.append(f"{name}: {row.related_series_id!r} has no forge model")
        if row.series_id in formations:
            found.append(f"{name}: {row.series_id!r} already has a forge model")
        if row.related_series_id in mapped:
            found.append(f"{name}: chain, {row.related_series_id!r} is itself mapped")
        if problem := _cars_problem(name, row, formations, cars):
            found.append(problem)
    return found


def body_problems(
    rows: Sequence[IdenticalBody],
    source_ids: Collection[str],
    series_ids: Collection[str],
    formations: Mapping[str, int],
    cars: Mapping[str, Cars],
) -> list[str]:
    """Every finding for the table.

    ``formations`` maps each series with a non-generic forge model to the cars of the model that is
    drawn for it; ``cars`` maps each series to its ``(cars_min, cars_max)``.
    """
    found = [p for row in rows for p in _row_problems(row, source_ids, series_ids)]
    pairs = Counter((row.series_id, row.related_series_id) for row in rows)
    found += [
        f"{FILE} {series_id} -> {related}: listed twice"
        for (series_id, related), count in pairs.items()
        if count > 1
    ]
    verdicts: dict[tuple[str, str], set[str]] = {}
    for row in rows:
        verdicts.setdefault((row.series_id, row.related_series_id), set()).add(row.verdict)
    found += [
        f"{FILE} {series_id} -> {related}: both accepted and rejected"
        for (series_id, related), seen in verdicts.items()
        if len(seen) > 1
    ]
    found += _accepted_problems(
        [row for row in rows if row.verdict == "accepted"], formations, cars
    )
    return found
