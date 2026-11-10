from pathlib import Path

import psycopg
import pytest
import yaml

from gerlines_catalog import commands
from gerlines_catalog.fingerprint import fingerprints
from gerlines_catalog.load import UnknownCategoryError, load
from gerlines_catalog.seeds import read_catalog

from .conftest import CATALOG


def run_load(url: str, folder: Path = CATALOG) -> dict[str, object]:
    with psycopg.connect(url) as conn:
        return load(conn, read_catalog(folder))


def test_loading_twice_gives_the_same_rows(database_url: str) -> None:
    first = run_load(database_url)
    with psycopg.connect(database_url) as conn:
        before = fingerprints(conn)
    second = run_load(database_url)
    with psycopg.connect(database_url) as conn:
        after = fingerprints(conn)
    assert first["first_load_of_this_content"] is True
    assert second["first_load_of_this_content"] is False
    assert first["alias_conflicts"] == second["alias_conflicts"] == 0
    assert before == after
    catalog = read_catalog(CATALOG)
    assert after["verbund"][0] == len(catalog.verbuende)
    assert after["line_colour"][0] == len(catalog.line_colours)
    assert after["operator"][0] == len(catalog.operators)


def test_rows_carry_names_sources_and_licences(database_url: str) -> None:
    run_load(database_url)
    with psycopg.connect(database_url) as conn:
        category = conn.execute(
            "SELECT name, name_de, name_pl, names_source_id FROM category"
            " WHERE category_code = 'hsr'"
        ).fetchone()
        assert category == (
            "High-speed rail",
            "Hochgeschwindigkeitsverkehr",
            "Koleje dużych prędkości",
            "gerlines",
        )
        unsourced = conn.execute(
            """
            SELECT count(*) FROM (
              SELECT source_id FROM verbund UNION ALL SELECT source_id FROM vehicle_series
              UNION ALL SELECT source_id FROM livery UNION ALL SELECT source_id FROM line_colour
              UNION ALL SELECT catalog_source_id FROM operator
            ) s LEFT JOIN source USING (source_id) WHERE source.licence IS NULL
            """
        ).fetchone()
        assert unsourced == (0,)
        fern = conn.execute(
            "SELECT name, name_source_id, wikidata_qid, wikidata_role FROM operator"
            " WHERE operator_id = 'db-fernverkehr-ag'"
        ).fetchone()
        assert fern == ("DB Fernverkehr AG", "delfi-gtfs", "Q452140", "company")


def test_rows_removed_from_the_seeds_leave_the_database(
    database_url: str, catalog_copy: Path
) -> None:
    run_load(database_url)
    path = catalog_copy / "liveries.yaml"
    rows = yaml.safe_load(path.read_text())
    dropped = rows.pop()
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))
    vehicles_path = catalog_copy / "vehicles.yaml"
    vehicles = yaml.safe_load(vehicles_path.read_text())
    for row in vehicles:
        if row.get("livery_id") == dropped["livery_id"]:
            del row["livery_id"]
            row.setdefault("missing", {})["livery_id"] = "dropped in this test"
    vehicles_path.write_text(yaml.safe_dump(vehicles, allow_unicode=True, sort_keys=False))
    operators_path = catalog_copy / "operators.yaml"
    operators = yaml.safe_load(operators_path.read_text())
    gone = next(o for o in operators if o.get("aliases"))
    operators.remove(gone)
    operators_path.write_text(yaml.safe_dump(operators, allow_unicode=True, sort_keys=False))
    lines_path = catalog_copy / "line-colours.csv"
    lines_path.write_text(
        "\n".join(
            line
            for line in lines_path.read_text().splitlines()
            if f",{gone['operator_id']}," not in line
        )
        + "\n"
    )
    series_path = catalog_copy / "vehicle-series.yaml"
    series = yaml.safe_load(series_path.read_text())
    for row in series:
        if gone["operator_id"] in row.get("operators", []):
            row["operators"].remove(gone["operator_id"])
    series_path.write_text(yaml.safe_dump(series, allow_unicode=True, sort_keys=False))
    run_load(database_url, catalog_copy)
    with psycopg.connect(database_url) as conn:
        assert conn.execute(
            "SELECT count(*) FROM livery WHERE livery_id = %s", (dropped["livery_id"],)
        ).fetchone() == (0,)
        kept = conn.execute(
            "SELECT name, brand_name, wikidata_qid FROM operator WHERE operator_id = %s",
            (gone["operator_id"],),
        ).fetchone()
        assert kept == (gone["feed_name"], None, None)
        aliases = conn.execute(
            "SELECT count(*) FROM operator_alias WHERE operator_id = %s AND source_id = 'wikidata'",
            (gone["operator_id"],),
        ).fetchone()
        assert aliases == (0,)


def test_static_import_aliases_survive_a_catalogue_load(database_url: str) -> None:
    run_load(database_url)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "INSERT INTO operator_alias (source_id, alias, operator_id)"
            " VALUES ('delfi-gtfs', 'DB Fernverkehr AG', 'db-fernverkehr-ag')"
        )
    run_load(database_url)
    with psycopg.connect(database_url) as conn:
        assert conn.execute(
            "SELECT count(*) FROM operator_alias WHERE source_id = 'delfi-gtfs'"
        ).fetchone() == (1,)


def test_a_category_without_migration_is_refused(database_url: str, catalog_copy: Path) -> None:
    path = catalog_copy / "categories.yaml"
    rows = yaml.safe_load(path.read_text())
    rows.append({**rows[0], "code": "cable", "sort_order": 10})
    path.write_text(yaml.safe_dump(rows, allow_unicode=True, sort_keys=False))
    with pytest.raises(UnknownCategoryError, match="cable"):
        run_load(database_url, catalog_copy)


def test_alias_conflicts_roll_the_whole_load_back(database_url: str, catalog_copy: Path) -> None:
    run_load(database_url)
    operators_path = catalog_copy / "operators.yaml"
    operators = yaml.safe_load(operators_path.read_text())
    owner = next(o for o in operators if o.get("aliases"))
    renamed = next(o for o in operators if o is not owner)
    renamed["brand_name"] = "Renamed in the copy"
    operators_path.write_text(yaml.safe_dump(operators, allow_unicode=True, sort_keys=False))
    alias = owner["aliases"][0]
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE operator_alias SET operator_id = %s WHERE source_id = %s AND alias = %s",
            (renamed["operator_id"], alias["source"], alias["alias"]),
        )
        before = fingerprints(conn)

    assert commands.load(catalog_copy, database_url, dry_run=False) == 3

    with psycopg.connect(database_url) as conn:
        assert fingerprints(conn) == before
        assert conn.execute(
            "SELECT brand_name FROM operator WHERE operator_id = %s", (renamed["operator_id"],)
        ).fetchone() != ("Renamed in the copy",)
        assert conn.execute("SELECT count(*) FROM catalog_version").fetchone() == (1,)


def test_fleet_rules_load_with_line_keys_and_model_names(database_url: str) -> None:
    run_load(database_url)
    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT scope, count(*) FROM fleet_rule GROUP BY scope ORDER BY scope"
        ).fetchall()
        catalog = read_catalog(CATALOG)
        assert sum(count for _, count in rows) == len(catalog.fleet_rules)
        assert conn.execute(
            "SELECT line_keys, series_ids, units FROM fleet_rule WHERE rule_id = 'nrw-s1'"
        ).fetchone() == (["S1"], ["db-422"], 2)
        assert conn.execute(
            "SELECT model_name FROM fleet_rule WHERE rule_id = 'generic-hsr'"
        ).fetchone() == ("Generic high speed train",)
        unknown = conn.execute(
            """
            SELECT count(*) FROM fleet_rule r, unnest(r.series_ids) s(series_id)
             WHERE NOT EXISTS (SELECT 1 FROM vehicle_series v WHERE v.series_id = s.series_id)
            """
        ).fetchone()
        assert unknown == (0,)
