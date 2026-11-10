import os
import secrets
from collections.abc import Callable, Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from gerlines_common import migration_statements

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "packages" / "db" / "migrations"
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
        if {"database_url", "database_factory"} & set(getattr(item, "fixturenames", ())):
            item.add_marker(pytest.mark.db)


def migrate(url: str, after: int = 0, until: int | None = None) -> None:
    """Apply the migrations in (after, until]; the scheduler stops once 0001 made the extension."""
    with psycopg.connect(url, autocommit=True) as conn:
        for path in sorted(MIGRATIONS.glob("*.up.sql")):
            version = int(path.name[:4])
            if version <= after or (until is not None and version > until):
                continue
            for statement in migration_statements(path.read_text()):
                conn.execute(statement)
            if version == 1:
                conn.execute("SELECT _timescaledb_functions.stop_background_workers()")


@pytest.fixture
def database_factory() -> Iterator[Callable[[int | None], str]]:
    """Throwaway databases migrated up to a version (all when None), scheduler stopped."""
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
    names: list[str] = []

    def create(until: int | None = None) -> str:
        name = f"gerlines_test_rollups_{secrets.token_hex(5)}"
        admin.execute(f'CREATE DATABASE "{name}" TEMPLATE template0')
        names.append(name)
        url = make_conninfo(server, dbname=name)
        migrate(url, until=until)
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(
                "SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs"
                " WHERE proc_name = 'policy_refresh_continuous_aggregate'"
            )
        return url

    with admin:
        try:
            yield create
        finally:
            for name in names:
                admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture
def migrator() -> Callable[..., None]:
    return migrate


@pytest.fixture
def database_url(database_factory: Callable[[int | None], str]) -> str:
    """A throwaway database with every migration applied and the refresh jobs paused."""
    return database_factory(None)
