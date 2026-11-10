"""Table fingerprints: row count and an MD5 over every row in key order, for idempotency checks."""

import psycopg
from psycopg import sql

TABLES = {
    "source": "source_id",
    "category": "category_code",
    "operator": "operator_id",
    "operator_alias": "source_id, alias",
    "verbund": "verbund_id",
    "vehicle_series": "series_id",
    "vehicle_series_operator": "series_id, operator_id",
    "livery": "livery_id",
    "livery_series": "livery_id, series_id",
    "livery_colour": "livery_id, colour_index",
    "line_colour": "line_colour_id",
    "fleet_rule": "rule_id",
    "catalog_version": "content_sha256",
}


def fingerprints(conn: psycopg.Connection) -> dict[str, tuple[int, str]]:
    result: dict[str, tuple[int, str]] = {}
    for table, order in TABLES.items():
        query = sql.SQL(
            "SELECT count(*), md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY {order}), ''))"
            " FROM {table} t"
        ).format(order=sql.SQL(order), table=sql.Identifier(table))
        row = conn.execute(query).fetchone()
        result[table] = (int(row[0]), str(row[1])) if row else (0, "")
    return result
