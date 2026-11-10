"""MobilityData gtfs-validator in Docker, pinned by digest, and a summary of its report."""

import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

VALIDATOR_IMAGE = (
    "ghcr.io/mobilitydata/gtfs-validator:8.0.1"
    "@sha256:26624464be966808662a78c85661b63a313ea936f3a3ee1dbb92c968415275ca"
)
REPORT_NAME = "report.json"
SEVERITY_ORDER = {"ERROR": 0, "WARNING": 1, "INFO": 2}


@dataclass(frozen=True, slots=True)
class ValidatorRun:
    feed: Path
    output_dir: Path
    memory: str = "10g"
    heap: str = "9g"
    threads: int = 4
    date: str | None = None
    country_code: str = "de"


def docker_command(run: ValidatorRun) -> list[str]:
    feed = run.feed.resolve()
    output = run.output_dir.resolve()
    command = [
        "docker",
        "run",
        "--rm",
        f"--memory={run.memory}",
        "-e",
        f"JAVA_TOOL_OPTIONS=-Xmx{run.heap}",
        "-v",
        f"{feed.parent}:/feed:ro",
        "-v",
        f"{output}:/out",
        VALIDATOR_IMAGE,
        "--input",
        f"/feed/{feed.name}",
        "--output_base",
        "/out",
        "--country_code",
        run.country_code,
        "--threads",
        str(run.threads),
        "--skip_validator_update",
        "--pretty",
    ]
    if run.date is not None:
        command += ["--date", run.date]
    return command


def run_validator(run: ValidatorRun) -> subprocess.CompletedProcess[str]:
    run.output_dir.mkdir(parents=True, exist_ok=True)
    return subprocess.run(  # noqa: S603
        docker_command(run), check=False, capture_output=True, text=True
    )


@dataclass(frozen=True, slots=True)
class NoticeCount:
    severity: str
    code: str
    total: int


def summarise(report: dict[str, object]) -> list[NoticeCount]:
    notices = report.get("notices", [])
    if not isinstance(notices, list):
        msg = "validator report has no notice list"
        raise TypeError(msg)
    counts = [
        NoticeCount(str(n["severity"]), str(n["code"]), int(n["totalNotices"])) for n in notices
    ]
    return sorted(counts, key=lambda c: (SEVERITY_ORDER.get(c.severity, 9), -c.total, c.code))


def summary_markdown(counts: Sequence[NoticeCount]) -> str:
    lines = ["| Severity | Notice code | Count |", "| --- | --- | --- |"]
    lines += [f"| {c.severity} | `{c.code}` | {c.total:,} |" for c in counts]
    return "\n".join(lines) + "\n"


def read_summary(output_dir: Path) -> list[NoticeCount]:
    return summarise(json.loads((output_dir / REPORT_NAME).read_text()))
