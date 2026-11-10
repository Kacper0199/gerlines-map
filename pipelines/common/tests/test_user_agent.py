import json
from pathlib import Path

import pytest

from gerlines_common.user_agent import MissingSettingError, user_agent, user_agent_from_env

REPO_ROOT = Path(__file__).parents[3]
VECTORS_PATH = REPO_ROOT / "packages" / "schema" / "test-vectors" / "user-agent.json"
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", VECTORS["valid"], ids=lambda vector: vector["contact"])
def test_formats_shared_valid_vectors(vector: dict[str, str]) -> None:
    assert user_agent(vector["appName"], vector["version"], vector["contact"]) == vector["expected"]


@pytest.mark.parametrize("app_name", VECTORS["invalidAppName"])
def test_rejects_invalid_app_name(app_name: str) -> None:
    with pytest.raises(ValueError, match="app name"):
        user_agent(app_name, "0.1.0", "trains@example.org")


@pytest.mark.parametrize("version", VECTORS["invalidVersion"])
def test_rejects_invalid_version(version: str) -> None:
    with pytest.raises(ValueError, match="version"):
        user_agent("gerlines", version, "trains@example.org")


@pytest.mark.parametrize("contact", VECTORS["invalidContact"])
def test_rejects_invalid_contact(contact: str) -> None:
    with pytest.raises(ValueError, match="contact"):
        user_agent("gerlines", "0.1.0", contact)


def test_reads_name_and_contact_from_environment() -> None:
    environ = {"APP_NAME": "gerlines", "APP_CONTACT": "trains@example.org"}
    assert user_agent_from_env("0.2.0", environ) == "gerlines/0.2.0 (+trains@example.org)"


@pytest.mark.parametrize(
    ("environ", "missing"),
    [
        ({"APP_CONTACT": "trains@example.org"}, "APP_NAME"),
        ({"APP_NAME": "gerlines"}, "APP_CONTACT"),
        ({"APP_NAME": "gerlines", "APP_CONTACT": ""}, "APP_CONTACT"),
    ],
)
def test_reports_missing_environment_setting(environ: dict[str, str], missing: str) -> None:
    with pytest.raises(MissingSettingError, match=missing):
        user_agent_from_env("0.2.0", environ)
