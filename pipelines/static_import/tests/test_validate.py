import json
from pathlib import Path

from gerlines_static_import.validate import (
    VALIDATOR_IMAGE,
    NoticeCount,
    ValidatorRun,
    docker_command,
    read_summary,
    summary_markdown,
)


def test_runs_the_image_pinned_by_digest_with_a_read_only_feed(tmp_path: Path) -> None:
    command = docker_command(
        ValidatorRun(
            feed=tmp_path / "in" / "feed.zip", output_dir=tmp_path / "out", date="2026-10-19"
        )
    )
    assert "@sha256:" in VALIDATOR_IMAGE
    assert command[:3] == ["docker", "run", "--rm"]
    assert f"{(tmp_path / 'in').resolve()}:/feed:ro" in command
    assert command[command.index("--input") + 1] == "/feed/feed.zip"
    assert command[-2:] == ["--date", "2026-10-19"]
    assert "JAVA_TOOL_OPTIONS=-Xmx9g" in command


def test_summarises_notices_by_severity_and_count(tmp_path: Path) -> None:
    (tmp_path / "report.json").write_text(
        json.dumps(
            {
                "notices": [
                    {"code": "fast_travel", "severity": "WARNING", "totalNotices": 5},
                    {"code": "unusable_trip", "severity": "ERROR", "totalNotices": 2},
                    {"code": "unknown_column", "severity": "INFO", "totalNotices": 9},
                    {"code": "stop_too_far", "severity": "WARNING", "totalNotices": 50},
                ]
            }
        )
    )
    counts = read_summary(tmp_path)
    assert counts == [
        NoticeCount("ERROR", "unusable_trip", 2),
        NoticeCount("WARNING", "stop_too_far", 50),
        NoticeCount("WARNING", "fast_travel", 5),
        NoticeCount("INFO", "unknown_column", 9),
    ]
    assert "| WARNING | `stop_too_far` | 50 |" in summary_markdown(counts)
