"""Canonical UUIDv5 ids over the fixed GerLines namespace (packages/db README, ids)."""

import uuid

GERLINES_NAMESPACE = uuid.UUID("5d1b7a4e-2f4c-5a8e-9c63-0b8f1e6d2a71")


def canonical_id(entity: str, natural_key: str) -> uuid.UUID:
    """UUIDv5 of ``<entity>:<natural key>``; the entity keeps a place and its point apart."""
    return uuid.uuid5(GERLINES_NAMESPACE, f"{entity}:{natural_key}")


def pattern_id(route_key: str, stop_keys: tuple[str, ...], shape_key: str) -> uuid.UUID:
    """Content id of a trip pattern: its route, its ordered stops and the shape it references."""
    parts = "\x1f".join([route_key, *stop_keys, shape_key])
    return uuid.uuid5(GERLINES_NAMESPACE, f"trip_pattern:{parts}")
