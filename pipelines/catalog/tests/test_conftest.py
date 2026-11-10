import pytest
from psycopg.conninfo import conninfo_to_dict

from .conftest import admin_url


def test_admin_work_uses_the_maintenance_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:5433/gerlines")
    assert conninfo_to_dict(admin_url())["dbname"] == "postgres"
    monkeypatch.delenv("DATABASE_URL")
    monkeypatch.setenv("POSTGRES_DB", "gerlines")
    assert conninfo_to_dict(admin_url())["dbname"] == "postgres"
