import os
import secrets
import shutil
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from gerlines_common import migration_statements

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "packages" / "db" / "migrations"
CATALOG = ROOT / "catalog"


@pytest.fixture
def catalog_copy(tmp_path: Path) -> Path:
    target = tmp_path / "catalog"
    shutil.copytree(CATALOG, target)
    return target


MAINTENANCE_DATABASE = "postgres"


def admin_url() -> str:
    """The server's maintenance database, never an application database such as ``gerlines``."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return make_conninfo(url, dbname=MAINTENANCE_DATABASE)
    return make_conninfo(
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=os.environ.get("POSTGRES_PORT", "5433"),
        user=os.environ.get("POSTGRES_USER", "gerlines"),
        password=os.environ.get("POSTGRES_PASSWORD", "change-me-locally"),
        dbname=MAINTENANCE_DATABASE,
    )


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "database_url" in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.db)


@pytest.fixture
def database_url() -> Iterator[str]:
    """A throwaway database with every migration applied; skipped when no server answers."""
    server = admin_url()
    required = os.environ.get("GERLINES_DB_TESTS") == "required" or os.environ.get("CI") in {
        "1",
        "true",
    }
    try:
        admin = psycopg.connect(server, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as error:
        if required:
            raise
        pytest.skip(f"no database server answers ({error.__class__.__name__}); run pnpm infra:up")
    name = f"gerlines_test_catalog_{secrets.token_hex(5)}"
    with admin:
        admin.execute(f'CREATE DATABASE "{name}" TEMPLATE template0')
        url = make_conninfo(server, dbname=name)
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                for path in sorted(MIGRATIONS.glob("*.up.sql")):
                    for statement in migration_statements(path.read_text()):
                        conn.execute(statement)
            yield url
        finally:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
