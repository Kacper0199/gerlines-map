import hashlib
import io
import json
from datetime import date
from pathlib import Path

import pytest

from gerlines_backfill.download import (
    DATASET,
    HubFile,
    VerificationError,
    download_month,
    file_url,
    hub_files,
    month_path,
    months_between,
    render_source,
)


def test_months_between_is_inclusive_and_crosses_years() -> None:
    assert months_between("2025-11", "2026-02") == ["2025-11", "2025-12", "2026-01", "2026-02"]
    assert months_between("2026-10", "2026-10") == ["2026-10"]
    with pytest.raises(ValueError, match="after"):
        months_between("2026-02", "2025-11")


def test_paths_and_urls_pin_the_revision() -> None:
    assert month_path("2025-11") == "monthly_processed_data/data-2025-11.parquet"
    assert file_url("abc123", "monthly_processed_data/data-2025-11.parquet") == (
        "https://huggingface.co/datasets/piebro/deutsche-bahn-data/resolve/abc123/"
        "monthly_processed_data/data-2025-11.parquet"
    )


def test_hub_files_reads_size_and_lfs_sha256() -> None:
    listing = [
        {
            "type": "file",
            "path": "monthly_processed_data/data-2026-10.parquet",
            "size": 369051703,
            "lfs": {"oid": "da907a23" + "0" * 56, "size": 369051703},
        },
        {"type": "directory", "path": "monthly_processed_data/x"},
    ]
    files = hub_files(json.dumps(listing).encode())
    assert files == {
        "monthly_processed_data/data-2026-10.parquet": HubFile(
            "monthly_processed_data/data-2026-10.parquet", 369051703, "da907a23" + "0" * 56
        )
    }


def _opener(payload: bytes, seen: list[tuple[str, dict[str, str]]]):
    def open_url(url: str, headers: dict[str, str]) -> io.BytesIO:
        seen.append((url, headers))
        return io.BytesIO(payload)

    return open_url


def test_download_month_verifies_sha256_and_sends_the_user_agent(tmp_path: Path) -> None:
    payload = b"PAR1 fake parquet bytes PAR1"
    digest = hashlib.sha256(payload).hexdigest()
    hub = HubFile(month_path("2025-11"), len(payload), digest)
    seen: list[tuple[str, dict[str, str]]] = []
    result = download_month(hub, "rev1", tmp_path, "GerLines/0.1.0 (+x)", _opener(payload, seen))
    assert result.path == tmp_path / "data-2025-11.parquet"
    assert result.path.read_bytes() == payload
    assert result.sha256 == digest
    assert seen[0][1] == {"User-Agent": "GerLines/0.1.0 (+x)"}
    assert not list(tmp_path.glob("*.part"))


def test_download_month_reuses_a_verified_file(tmp_path: Path) -> None:
    payload = b"already here"
    hub = HubFile(month_path("2025-12"), len(payload), hashlib.sha256(payload).hexdigest())
    (tmp_path / "data-2025-12.parquet").write_bytes(payload)
    seen: list[tuple[str, dict[str, str]]] = []
    result = download_month(hub, "rev1", tmp_path, "ua", _opener(b"other", seen))
    assert result.reused
    assert seen == []


def test_download_month_refuses_a_wrong_digest_and_keeps_nothing(tmp_path: Path) -> None:
    hub = HubFile(month_path("2026-01"), 5, "0" * 64)
    with pytest.raises(VerificationError, match="sha256"):
        download_month(hub, "rev1", tmp_path, "ua", _opener(b"12345", []))
    assert list(tmp_path.iterdir()) == []


def test_render_source_names_licence_attribution_and_digests() -> None:
    text = render_source(
        revision="d627358d",
        fetched=date(2026, 11, 8),
        rows=[("data-2025-11.parquet", 345215668, "a" * 64)],
    )
    assert f"https://huggingface.co/datasets/{DATASET}" in text
    assert "d627358d" in text
    assert "CC BY 4.0" in text
    assert "https://creativecommons.org/licenses/by/4.0/" in text
    assert "| `data-2025-11.parquet` | 345,215,668 | " + "a" * 64 + " |" in text
