"""The statistics rules written once more, apart from the migrations, so the check is independent.

Delays earlier than 30 minutes ahead of the timetable are no data (D-040). Bin edges: architecture
section 4 with one-minute delay bins up to 16 minutes, so DB's 5:59 and 15:59 punctuality rules fall
on bin edges. Source order per stop: a live final before a carried one (a carried final is a
prediction frozen after the source stopped reporting), then the rank of D-041 item 3 (long distance
IRIS, gtfs.de, DELFI; others DELFI, gtfs.de), then inside DELFI Mobilithek, the mirror and the
de-incremented copy (D-041 item 2), then the source id.
"""

from dataclasses import dataclass

EARLIEST_DELAY_S = -1800

DELAY_EDGES: tuple[int, ...] = (
    -1800,
    -300,
    *range(0, 961, 60),
    *range(1200, 3601, 300),
    5400,
    7200,
)
GAIN_EDGES: tuple[int, ...] = (-600, -300, *range(-240, 601, 60), 900, 1800, 3600)
SPEED_EDGES_KMH: tuple[int, ...] = tuple(range(10, 301, 10))

LONG_DISTANCE = frozenset({"hsr", "ld"})
IRIS = "db-iris"
DELFI_ORDER: tuple[str, ...] = ("mobilithek-delfi-gtfs-rt", "delfi-gtfs-rt", "delfi-gtfs-rt-deincr")
DELFI = frozenset(DELFI_ORDER)
REGIONAL = frozenset({"vbb-gtfs-rt", "vbn-gtfs-rt"})


@dataclass(frozen=True, slots=True)
class Bins:
    kind: str
    edges: tuple[int, ...]
    lowest: int | None

    @property
    def count(self) -> int:
        return len(self.edges) + 1


DELAY = Bins("delay", DELAY_EDGES[1:], EARLIEST_DELAY_S)
GAIN = Bins("gain", GAIN_EDGES, None)
SPEED = Bins("speed", SPEED_EDGES_KMH, 0)


def bin_of(bins: Bins, value: float | None) -> int | None:
    """The 0-based bin of ``value``; None for no data (below the lowest edge or missing)."""
    if value is None or (bins.lowest is not None and value < bins.lowest):
        return None
    for index, edge in enumerate(bins.edges):
        if value < edge:
            return index
    return len(bins.edges)


def bin_case_sql(bins: Bins, expression: str) -> str:
    """A SQL CASE that maps ``expression`` to its bin, written from the edges above."""
    whens = [f"WHEN ({expression}) IS NULL THEN NULL"]
    if bins.lowest is not None:
        whens.append(f"WHEN ({expression}) < {bins.lowest} THEN NULL")
    whens += [f"WHEN ({expression}) < {edge} THEN {index}" for index, edge in enumerate(bins.edges)]
    return f"(CASE {' '.join(whens)} ELSE {len(bins.edges)} END)"


def source_rank(category_code: str | None, source_id: str) -> int:
    if category_code in LONG_DISTANCE:
        order = ("iris", "gtfsde", "delfi", "regional", "neighbour")
    else:
        order = ("delfi", "gtfsde", "regional", "neighbour", "iris")
    if source_id == IRIS:
        group = "iris"
    elif source_id == "gtfsde-rt":
        group = "gtfsde"
    elif source_id in DELFI:
        group = "delfi"
    elif source_id in REGIONAL:
        group = "regional"
    else:
        group = "neighbour"
    return order.index(group)


def source_rank_sql(category: str, source: str) -> str:
    """The rank as a SQL CASE over the same groups as :func:`source_rank`."""

    def group_case(order: tuple[str, ...]) -> str:
        rank = {name: index for index, name in enumerate(order)}
        delfi = ", ".join(f"'{s}'" for s in sorted(DELFI))
        regional = ", ".join(f"'{s}'" for s in sorted(REGIONAL))
        return (
            f"CASE WHEN {source} = '{IRIS}' THEN {rank['iris']} "
            f"WHEN {source} = 'gtfsde-rt' THEN {rank['gtfsde']} "
            f"WHEN {source} IN ({delfi}) THEN {rank['delfi']} "
            f"WHEN {source} IN ({regional}) THEN {rank['regional']} "
            f"ELSE {rank['neighbour']} END"
        )

    long_distance = group_case(("iris", "gtfsde", "delfi", "regional", "neighbour"))
    other = group_case(("delfi", "gtfsde", "regional", "neighbour", "iris"))
    return f"(CASE WHEN {category} IN ('hsr', 'ld') THEN {long_distance} ELSE {other} END)"


def member_order(source_id: str) -> int:
    """Order inside a rank group; only DELFI has more than one member."""
    return DELFI_ORDER.index(source_id) if source_id in DELFI else 0


def source_order_sql(category: str, source: str, final_quality: str | None) -> str:
    """ORDER BY terms that pick the stop's source the way ``stat_source_key`` does."""
    members = " ".join(f"WHEN '{s}' THEN {member_order(s)}" for s in DELFI_ORDER)
    terms = [
        source_rank_sql(category, source),
        f"(CASE {source} {members} ELSE 0 END)",
        source,
    ]
    if final_quality is not None:
        terms.insert(0, f"(CASE WHEN {final_quality} = 'carried' THEN 1 ELSE 0 END)")
    return ", ".join(terms)
