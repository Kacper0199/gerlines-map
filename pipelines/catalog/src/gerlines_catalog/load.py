"""Upsert a validated catalogue into the database in one transaction.

Tables the catalogue owns (verbund, vehicle_series and their links, livery, line_colour) end up
exactly as the seeds say: rows missing from the seeds are deleted. Rows it shares with the static
import (category, operator, operator_alias) only get the catalogue's columns written; operators
dropped from the seeds lose those columns, and only aliases from catalogue sources are removed.
A second load of the same seeds changes nothing.
"""

from collections.abc import Sequence

import psycopg
from psycopg.types.json import Jsonb

from gerlines_catalog.fleet import line_key
from gerlines_catalog.models import STATIC_IMPORT_ALIAS_SOURCES
from gerlines_catalog.seeds import Catalog


class UnknownCategoryError(RuntimeError):
    """The seeds name a category code that no migration created."""


def _json(value: object) -> Jsonb:
    return Jsonb(value)


def upsert_sources(conn: psycopg.Connection, catalog: Catalog) -> None:
    conn.cursor().executemany(
        """
        INSERT INTO source (source_id, name, homepage_url, licence, licence_url, attribution)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (source_id) DO UPDATE SET
          name = excluded.name, homepage_url = excluded.homepage_url,
          licence = excluded.licence, licence_url = excluded.licence_url,
          attribution = excluded.attribution
        WHERE (source.name, source.homepage_url, source.licence, source.licence_url,
               source.attribution)
              IS DISTINCT FROM
              (excluded.name, excluded.homepage_url, excluded.licence, excluded.licence_url,
               excluded.attribution)
        """,
        [
            (s.source_id, s.name, str(s.homepage_url), s.licence, str(s.licence_url), s.attribution)
            for s in catalog.sources
        ],
    )


def update_categories(conn: psycopg.Connection, catalog: Catalog) -> None:
    known = {row[0] for row in conn.execute("SELECT category_code FROM category").fetchall()}
    unknown = sorted({c.code for c in catalog.categories} - known)
    if unknown:
        msg = f"categories without a migration: {', '.join(unknown)}"
        raise UnknownCategoryError(msg)
    conn.cursor().executemany(
        """
        UPDATE category SET name = %s, name_de = %s, name_pl = %s, names_source_id = %s
         WHERE category_code = %s
           AND (name, name_de, name_pl, names_source_id) IS DISTINCT FROM (%s, %s, %s, %s)
        """,
        [
            (
                c.name.en,
                c.name.de,
                c.name.pl,
                c.source,
                c.code,
                c.name.en,
                c.name.de,
                c.name.pl,
                c.source,
            )
            for c in catalog.categories
        ],
    )


_OPERATOR_COLUMNS = (
    "brand_name", "legal_name", "wikidata_qid", "wikidata_role", "wikidata_basis_source_id",
    "website_url", "parents", "valid_from", "valid_to", "catalog_source_id", "field_sources",
    "missing",
)  # fmt: skip


def upsert_operators(conn: psycopg.Connection, catalog: Catalog) -> None:
    rows = [
        (
            o.operator_id,
            o.feed_name,
            o.country,
            o.brand_name,
            o.legal_name,
            o.wikidata_qid,
            o.wikidata_role.value if o.wikidata_role else None,
            o.wikidata_basis,
            str(o.website) if o.website else None,
            _json([p.model_dump(mode="json", exclude_none=True) for p in o.parents]),
            o.valid_from,
            o.valid_to,
            o.source,
            _json(o.field_sources),
            _json(o.missing),
        )
        for o in catalog.operators
    ]
    assignments = ", ".join(f"{c} = excluded.{c}" for c in _OPERATOR_COLUMNS)
    current = ", ".join(f"operator.{c}" for c in _OPERATOR_COLUMNS)
    incoming = ", ".join(f"excluded.{c}" for c in _OPERATOR_COLUMNS)
    conn.cursor().executemany(
        f"""
        INSERT INTO operator (operator_id, name, name_source_id, country_code,
                              {", ".join(_OPERATOR_COLUMNS)})
        VALUES (%s, %s, 'delfi-gtfs', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (operator_id) DO UPDATE SET
          country_code = COALESCE(excluded.country_code, operator.country_code),
          {assignments}
        WHERE ({current}, COALESCE(excluded.country_code, operator.country_code))
              IS DISTINCT FROM ({incoming}, operator.country_code)
        """,  # noqa: S608
        rows,
    )
    nulls = ", ".join(
        f"{c} = DEFAULT" if c in {"parents", "field_sources", "missing"} else f"{c} = NULL"
        for c in _OPERATOR_COLUMNS
    )
    conn.execute(
        f"""
        UPDATE operator SET {nulls}
         WHERE catalog_source_id IS NOT NULL AND NOT (operator_id = ANY(%s))
        """,  # noqa: S608
        ([o.operator_id for o in catalog.operators],),
    )


def sync_aliases(conn: psycopg.Connection, catalog: Catalog) -> int:
    """Write catalogue aliases; return how many already belong to another operator."""
    rows = [
        (a.source, a.alias, o.operator_id, a.valid_from, a.valid_to)
        for o in catalog.operators
        for a in o.aliases
    ]
    alias_sources = sorted({row[0] for row in rows} - STATIC_IMPORT_ALIAS_SOURCES)
    conflicts = 0
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(
                """
                INSERT INTO operator_alias (source_id, alias, operator_id, valid_from, valid_to)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (source_id, alias) DO UPDATE SET
                  valid_from = excluded.valid_from, valid_to = excluded.valid_to
                WHERE operator_alias.operator_id = excluded.operator_id
                  AND (operator_alias.valid_from, operator_alias.valid_to)
                      IS DISTINCT FROM (excluded.valid_from, excluded.valid_to)
                """,
                row,
            )
            owner = cur.execute(
                "SELECT operator_id FROM operator_alias WHERE source_id = %s AND alias = %s",
                row[:2],
            ).fetchone()
            if owner is None or owner[0] != row[2]:
                conflicts += 1
        cur.execute(
            """
            DELETE FROM operator_alias a
             WHERE a.source_id = ANY(%s)
               AND NOT EXISTS (
                 SELECT 1 FROM unnest(%s::text[], %s::text[]) AS k(source_id, alias)
                  WHERE k.source_id = a.source_id AND k.alias = a.alias)
            """,
            (alias_sources, [r[0] for r in rows], [r[1] for r in rows]),
        )
    return conflicts


def _replace_owned(conn: psycopg.Connection, table: str, key: str, keys: Sequence[str]) -> None:
    conn.execute(
        f"DELETE FROM {table} WHERE NOT ({key} = ANY(%s))",  # noqa: S608
        (list(keys),),
    )


def upsert_verbuende(conn: psycopg.Connection, catalog: Catalog) -> None:
    columns = (
        "abbr", "name", "laender", "spnv_integrated", "wikidata_qid", "website_url", "source_id",
        "field_sources", "missing",
    )  # fmt: skip
    _upsert(
        conn,
        "verbund",
        "verbund_id",
        columns,
        [
            (
                v.verbund_id,
                v.abbr,
                v.name,
                list(v.laender),
                v.spnv_integrated,
                v.wikidata_qid,
                str(v.website) if v.website else None,
                v.source,
                _json(v.field_sources),
                _json(v.missing),
            )
            for v in catalog.verbuende
        ],
    )
    _replace_owned(conn, "verbund", "verbund_id", [v.verbund_id for v in catalog.verbuende])


def upsert_series(conn: psycopg.Connection, catalog: Catalog) -> None:
    columns = (
        "name", "br", "family", "manufacturers", "traction", "unit_kind", "double_deck",
        "cars_min", "cars_max", "unit_length_m", "max_speed_kmh", "priority", "wikidata_qid",
        "commons_category", "dewiki_title", "source_id", "field_sources", "missing",
    )  # fmt: skip
    _upsert(
        conn,
        "vehicle_series",
        "series_id",
        columns,
        [
            (
                s.series_id,
                s.name,
                s.br,
                s.family,
                list(s.manufacturers),
                s.traction.value if s.traction else None,
                s.unit_kind.value if s.unit_kind else None,
                s.double_deck,
                s.cars_min,
                s.cars_max,
                s.unit_length_m,
                s.max_speed_kmh,
                s.priority.value,
                s.wikidata_qid,
                s.commons_category,
                s.dewiki_title,
                s.source,
                _json(s.field_sources),
                _json(s.missing),
            )
            for s in catalog.vehicle_series
        ],
    )
    links = [
        (s.series_id, operator, s.source_of("operators"))
        for s in catalog.vehicle_series
        for operator in s.operators
    ]
    _replace_links(
        conn,
        "vehicle_series_operator",
        ("series_id", "operator_id", "source_id"),
        links,
    )
    _replace_owned(
        conn, "vehicle_series", "series_id", [s.series_id for s in catalog.vehicle_series]
    )


def upsert_liveries(conn: psycopg.Connection, catalog: Catalog) -> None:
    _upsert(
        conn,
        "livery",
        "livery_id",
        ("name", "operator_id", "valid_from", "valid_to", "source_id", "missing"),
        [
            (
                lv.livery_id,
                lv.name,
                lv.operator_id,
                lv.valid_from,
                lv.valid_to,
                lv.source,
                _json(lv.missing),
            )
            for lv in catalog.liveries
        ],
    )
    _replace_owned(conn, "livery", "livery_id", [lv.livery_id for lv in catalog.liveries])
    _replace_links(
        conn,
        "livery_series",
        ("livery_id", "series_id"),
        [(lv.livery_id, s) for lv in catalog.liveries for s in lv.series_ids],
    )
    _replace_links(
        conn,
        "livery_colour",
        ("livery_id", "colour_index", "role", "name", "ral", "hex", "source_id", "hex_source_id"),
        [
            (lv.livery_id, index, c.role, c.name, c.ral, c.hex, c.source, c.hex_source)
            for lv in catalog.liveries
            for index, c in enumerate(lv.colours)
        ],
    )


def upsert_line_colours(conn: psycopg.Connection, catalog: Catalog) -> None:
    columns = (
        "upstream_operator", "line_name", "delfi_agency_key", "delfi_agency_name", "operator_id",
        "background_hex", "text_hex", "border_hex", "shape", "line_wikidata_qid", "source_id",
    )  # fmt: skip
    _upsert(
        conn,
        "line_colour",
        "line_colour_id",
        columns,
        [
            (
                lc.line_colour_id,
                lc.upstream_operator,
                lc.line_name,
                lc.delfi_agency_key,
                lc.delfi_agency_name,
                lc.operator_id,
                lc.background_hex,
                lc.text_hex,
                lc.border_hex,
                lc.shape.value,
                lc.line_wikidata_qid,
                lc.source,
            )
            for lc in catalog.line_colours
        ],
    )
    _replace_owned(
        conn, "line_colour", "line_colour_id", [lc.line_colour_id for lc in catalog.line_colours]
    )


def upsert_fleet_rules(conn: psycopg.Connection, catalog: Catalog) -> None:
    model_names = {v.model_id: v.name for v in catalog.vehicles}
    columns = (
        "scope", "operator_id", "category_code", "line_keys", "series_ids", "model_id",
        "model_name", "units", "fleet_count", "fleet_total", "valid_from", "valid_to",
        "source_id", "evidence",
    )  # fmt: skip
    _upsert(
        conn,
        "fleet_rule",
        "rule_id",
        columns,
        [
            (
                rule.rule_id,
                rule.scope.value,
                rule.operator_id,
                rule.category,
                [line_key(line) for line in rule.lines],
                list(rule.series_ids),
                rule.model_id,
                model_names.get(rule.model_id) if rule.model_id else None,
                rule.units,
                rule.fleet_count,
                rule.fleet_total,
                rule.valid_from,
                rule.valid_to,
                rule.source,
                rule.evidence,
            )
            for rule in catalog.fleet_rules
        ],
    )
    _replace_owned(conn, "fleet_rule", "rule_id", [r.rule_id for r in catalog.fleet_rules])


def _upsert(
    conn: psycopg.Connection,
    table: str,
    key: str,
    columns: Sequence[str],
    rows: Sequence[tuple],
) -> None:
    if not rows:
        return
    names = ", ".join((key, *columns))
    placeholders = ", ".join(["%s"] * (len(columns) + 1))
    assignments = ", ".join(f"{c} = excluded.{c}" for c in columns)
    current = ", ".join(f"{table}.{c}" for c in columns)
    incoming = ", ".join(f"excluded.{c}" for c in columns)
    conn.cursor().executemany(
        f"""
        INSERT INTO {table} ({names}) VALUES ({placeholders})
        ON CONFLICT ({key}) DO UPDATE SET {assignments}
        WHERE ({current}) IS DISTINCT FROM ({incoming})
        """,  # noqa: S608
        rows,
    )


def _replace_links(
    conn: psycopg.Connection,
    table: str,
    columns: Sequence[str],
    rows: Sequence[tuple],
) -> None:
    """Make ``table`` hold exactly ``rows``; the first two columns form the key."""
    keys = columns[:2]
    rest = columns[2:]
    names = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    conflict = ", ".join(keys)
    if rest:
        assignments = ", ".join(f"{c} = excluded.{c}" for c in rest)
        current = ", ".join(f"{table}.{c}" for c in rest)
        incoming = ", ".join(f"excluded.{c}" for c in rest)
        action = (
            f"DO UPDATE SET {assignments} WHERE ({current}) IS DISTINCT FROM ({incoming})"
            if len(rest) > 1
            else f"DO UPDATE SET {assignments} WHERE {current} IS DISTINCT FROM {incoming}"
        )
    else:
        action = "DO NOTHING"
    if rows:
        conn.cursor().executemany(
            f"INSERT INTO {table} ({names}) VALUES ({placeholders})"  # noqa: S608
            f" ON CONFLICT ({conflict}) {action}",
            rows,
        )
    first, second = keys
    conn.execute(
        f"""
        DELETE FROM {table} t
         WHERE NOT EXISTS (
           SELECT 1 FROM unnest(%s::text[], %s::text[]) AS k(a, b)
            WHERE k.a = t.{first}::text AND k.b = t.{second}::text)
        """,  # noqa: S608
        ([str(row[0]) for row in rows], [str(row[1]) for row in rows]),
    )


def record_version(conn: psycopg.Connection, catalog: Catalog) -> bool:
    """Record the content hash; return whether this content was loaded for the first time."""
    row = conn.execute(
        """
        INSERT INTO catalog_version (content_sha256, row_counts) VALUES (%s, %s)
        ON CONFLICT (content_sha256) DO NOTHING RETURNING content_sha256
        """,
        (catalog.content_sha256, _json(catalog.counts())),
    ).fetchone()
    return row is not None


def load(conn: psycopg.Connection, catalog: Catalog) -> dict[str, object]:
    """Write ``catalog``; the caller owns the transaction."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('gerlines-catalog', 0))")
    upsert_sources(conn, catalog)
    update_categories(conn, catalog)
    upsert_operators(conn, catalog)
    alias_conflicts = sync_aliases(conn, catalog)
    upsert_verbuende(conn, catalog)
    upsert_series(conn, catalog)
    upsert_liveries(conn, catalog)
    upsert_line_colours(conn, catalog)
    upsert_fleet_rules(conn, catalog)
    first = record_version(conn, catalog)
    return {
        "content_sha256": catalog.content_sha256,
        "first_load_of_this_content": first,
        "alias_conflicts": alias_conflicts,
        "rows": catalog.counts(),
    }
