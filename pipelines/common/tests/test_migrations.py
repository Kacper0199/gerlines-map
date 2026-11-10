import hashlib
import json
from pathlib import Path

from gerlines_common import migration_statements, split_statements

MIGRATIONS = Path(__file__).resolve().parents[3] / "packages" / "db" / "migrations"


def test_a_transactional_file_is_sent_whole() -> None:
    sql = "CREATE TABLE t (c int);\nINSERT INTO t VALUES (1);\n"
    assert migration_statements(sql) == [sql]


def test_a_no_transaction_file_is_sent_one_statement_at_a_time() -> None:
    sql = (
        "-- gerlines:no-transaction\n"
        "SELECT remove_continuous_aggregate_policy('a', if_exists => true);\n"
        "CALL refresh_continuous_aggregate('a', NULL, (now() + INTERVAL '7 days')::date);\n"
    )
    assert migration_statements(sql) == [
        "-- gerlines:no-transaction\n"
        "SELECT remove_continuous_aggregate_policy('a', if_exists => true);",
        "CALL refresh_continuous_aggregate('a', NULL, (now() + INTERVAL '7 days')::date);",
    ]


def test_semicolons_inside_quotes_dollar_bodies_and_comments_do_not_split() -> None:
    sql = (
        "-- gerlines:no-transaction\n"
        "SELECT 'a;b', \"c;d\";\n"
        "-- note; still a comment\n"
        "/* block; /* nested; */ comment */ SELECT $x$ e; f $x$;\n"
        "SELECT $$ g; $$;"
    )
    assert migration_statements(sql) == [
        "-- gerlines:no-transaction\nSELECT 'a;b', \"c;d\";",
        "-- note; still a comment\n/* block; /* nested; */ comment */ SELECT $x$ e; f $x$;",
        "SELECT $$ g; $$;",
    ]


def test_every_committed_no_transaction_migration_splits_into_single_statements() -> None:
    found = 0
    for path in sorted(MIGRATIONS.glob("*.sql")):
        sql = path.read_text()
        if sql.startswith("-- gerlines:no-transaction\n"):
            found += 1
            statements = migration_statements(sql)
            assert len(statements) == sql.count(";\n")
    assert found >= 1


def test_an_escape_string_keeps_a_backslash_quote_inside() -> None:
    assert split_statements("SELECT E'it\\'s;';\nSELECT 2;") == ["SELECT E'it\\'s;';", "SELECT 2;"]


def test_a_word_ending_in_e_before_a_quote_is_not_an_escape_string() -> None:
    assert split_statements("SELECT abcE'a\\';\nSELECT 2;") == ["SELECT abcE'a\\';", "SELECT 2;"]


def test_a_dollar_sign_inside_an_identifier_opens_no_dollar_quote() -> None:
    assert split_statements("SELECT 1 AS a$$b;\nSELECT 2;") == ["SELECT 1 AS a$$b;", "SELECT 2;"]


def test_parts_that_hold_only_comments_or_whitespace_are_dropped() -> None:
    sql = "-- header\n;\n/* note */\nSELECT 1;\n-- trailing\n"
    assert split_statements(sql) == ["/* note */\nSELECT 1;"]


GOLDEN = Path(__file__).resolve().parents[3] / "packages" / "db" / "src" / "split-golden.json"


def digest(statement: str) -> str:
    return hashlib.sha256(statement.encode()).hexdigest()


def test_the_cases_split_as_the_typescript_runner_splits_them() -> None:
    cases = json.loads(GOLDEN.read_text())["cases"]
    assert cases
    for case in cases:
        assert split_statements(case["sql"]) == case["statements"], case["name"]


def test_every_committed_migration_splits_as_the_typescript_runner_splits_it() -> None:
    files = json.loads(GOLDEN.read_text())["files"]
    committed = {path.name: path for path in sorted(MIGRATIONS.glob("*.sql"))}
    assert sorted(files) == sorted(committed)
    for name, path in committed.items():
        sql = path.read_bytes().decode()
        assert [digest(s) for s in split_statements(sql)] == files[name], name
