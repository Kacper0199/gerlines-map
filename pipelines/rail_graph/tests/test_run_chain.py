"""run-chain.sh with a stand-in for caffeinate on PATH."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run-chain.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")

CAFFEINATE = r"""#!/usr/bin/env bash
echo "$*" >"$FAKE/caffeinate"
exec "${@:2}"
"""

STEP = r"""#!/usr/bin/env bash
echo "$GUARD_WAIT_S $GUARD_RETRIES $*" >"$FAKE/step"
exit "${STEP_EXIT:-0}"
"""


def chain(tmp_path: Path, *args: str, caffeinate: bool = True, **env: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    step = tmp_path / "step.sh"
    step.write_text(STEP)
    step.chmod(0o755)
    if caffeinate:
        (bin_dir / "caffeinate").write_text(CAFFEINATE)
        (bin_dir / "caffeinate").chmod(0o755)
    system = ["/usr/bin", "/bin"] if caffeinate else ["/bin"]
    path = os.pathsep.join([str(bin_dir), *system])
    environ = {"PATH": path, "FAKE": str(tmp_path), **env}
    result = subprocess.run(  # noqa: S603
        ["/bin/bash", str(SCRIPT), str(step), *args],
        capture_output=True,
        text=True,
        env=environ,
        timeout=30,
        check=False,
    )
    return result, step


def test_it_sets_the_chain_settings_and_keeps_the_mac_awake(tmp_path):
    result, step = chain(tmp_path, "a", "b")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "step").read_text().strip() == "3600 1 a b"
    assert (tmp_path / "caffeinate").read_text().strip() == f"-dims {step} a b"


def test_values_in_the_environment_win_and_the_status_passes_through(tmp_path):
    result, _ = chain(tmp_path, GUARD_WAIT_S="120", GUARD_RETRIES="0", STEP_EXIT="3")
    assert result.returncode == 3
    assert (tmp_path / "step").read_text().strip() == "120 0"


def test_without_caffeinate_it_runs_the_chain_and_says_so(tmp_path):
    result, _ = chain(tmp_path, caffeinate=False)
    assert result.returncode == 0
    assert "caffeinate not found" in result.stderr


def test_without_a_command_it_shows_the_usage(tmp_path):
    result = subprocess.run(  # noqa: S603
        ["/bin/bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 2
    assert "usage: run-chain.sh" in result.stderr
