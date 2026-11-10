"""Encoded polyline format (Google), as MOTIS returns trip geometry; coordinates are (lat, lon)."""

from collections.abc import Iterable


def _read_value(text: str, index: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if index >= len(text):
            msg = "encoded polyline is truncated"
            raise ValueError(msg)
        byte = ord(text[index]) - 63
        index += 1
        result |= (byte & 0x1F) << shift
        shift += 5
        if byte < 0x20:
            break
    value = ~(result >> 1) if result & 1 else result >> 1
    return value, index


def decode(text: str, precision: int) -> list[tuple[float, float]]:
    factor = 10**precision
    points: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lon = 0
    while index < len(text):
        d_lat, index = _read_value(text, index)
        d_lon, index = _read_value(text, index)
        lat += d_lat
        lon += d_lon
        points.append((lat / factor, lon / factor))
    return points


def _write_value(value: int) -> str:
    value = ~(value << 1) if value < 0 else value << 1
    chunks = []
    while value >= 0x20:
        chunks.append(chr((0x20 | (value & 0x1F)) + 63))
        value >>= 5
    chunks.append(chr(value + 63))
    return "".join(chunks)


def encode(points: Iterable[tuple[float, float]], precision: int) -> str:
    factor = 10**precision
    out = []
    prev_lat = 0
    prev_lon = 0
    for lat, lon in points:
        lat_i = round(lat * factor)
        lon_i = round(lon * factor)
        out.append(_write_value(lat_i - prev_lat))
        out.append(_write_value(lon_i - prev_lon))
        prev_lat, prev_lon = lat_i, lon_i
    return "".join(out)
