"""run-pfaedle.sh against stand-ins for docker, uname, sysctl, memory_pressure and /proc."""

import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run-pfaedle.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")

DOCKER = r"""#!/usr/bin/env bash
f="$FAKE"
echo "$1" >>"$f/calls"
case "$1" in
  run) echo $(( $(cat "$f/attempt" 2>/dev/null || echo 0) + 1 )) >"$f/attempt"
       echo "${RUNNING_TICKS:-1}" >"$f/ticks"; echo running >"$f/state"; echo id ;;
  inspect)
    a=$(cat "$f/attempt")
    if [[ "$3" == *Running* ]]; then
      t=$(cat "$f/ticks")
      hang=0; [[ "$a" == "${HANG_ATTEMPT:-0}" || -n "${HANG_FOREVER:-}" ]] && hang=1
      if [[ "$(cat "$f/state")" == running ]] && ((hang || t > 0)); then
        echo $((t - 1)) >"$f/ticks"; echo true
      else echo false; fi
    else
      [[ "$(cat "$f/state")" == stopped ]] && echo "${STOP_EXIT:-137}" || echo 0
    fi ;;
  stats) echo "512MiB / 8GiB" ;;
  stop) echo stopped >"$f/state" ;;
  logs) echo "pfaedle attempt $(cat "$f/attempt")" ;;
  rm) ;;
esac
"""

SYSCTL = r"""#!/usr/bin/env bash
if [[ "$2" == vm.swapusage ]]; then
  a=$(cat "$FAKE/attempt" 2>/dev/null || echo 0)
  used=1000.00M
  state=$(cat "$FAKE/state" 2>/dev/null)
  [[ "$a" == "${HANG_ATTEMPT:-0}" && "$state" == running ]] && used=5000.00M
  [[ "$state" == stopped && -n "${SWAP_AFTER_STOP:-}" ]] && used="${SWAP_AFTER_STOP}.00M"
  echo "total = 20480.00M  used = $used  free = 1.00M  (encrypted)"
else
  echo 1
fi
"""

UNAME = r"""#!/usr/bin/env bash
echo "${FAKE_UNAME:-Darwin}"
"""

MEMORY_PRESSURE = r"""#!/usr/bin/env bash
q="$FAKE/free"
v=$(head -n 1 "$q")
(( $(wc -l <"$q") > 1 )) && { tail -n +2 "$q" >"$q.next"; mv "$q.next" "$q"; }
echo "System-wide memory free percentage: ${v}%"
"""


def prepare(tmp_path: Path, free: list[int], env: dict[str, str]) -> dict[str, str]:
    bin_dir, fake, out = tmp_path / "bin", tmp_path / "fake", tmp_path / "out"
    for path in (bin_dir, fake, out):
        path.mkdir(exist_ok=True)
    for name, body in (
        ("docker", DOCKER),
        ("uname", UNAME),
        ("sysctl", SYSCTL),
        ("memory_pressure", MEMORY_PRESSURE),
    ):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    (fake / "free").write_text("".join(f"{v}\n" for v in free))
    osm, trains = tmp_path / "de.osm.pbf", tmp_path / "trains.zip"
    osm.write_bytes(b"")
    trains.write_bytes(b"")
    return {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE": str(fake),
        "GERLINES_MAIN": str(tmp_path),
        "RAIL_GRAPH_OUT": str(out),
        "TRAINS_ZIP": str(trains),
        "GUARD_INTERVAL_S": "0",
        **env,
    }


def run(tmp_path: Path, free: list[int], **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["bash", str(SCRIPT), "t", str(tmp_path / "de.osm.pbf")],  # noqa: S607
        capture_output=True,
        text=True,
        env=prepare(tmp_path, free, env),
        timeout=60,
        check=False,
    )


def test_below_the_floor_it_refuses_at_once_by_default(tmp_path):
    result = run(tmp_path, [39])
    assert result.returncode == 1
    assert "refusing to start: 39 % memory free, floor 40 %" in result.stderr
    assert not (tmp_path / "fake" / "attempt").exists()


def test_with_a_wait_it_polls_logs_each_wait_and_starts_once_memory_is_back(tmp_path):
    result = run(tmp_path, [35, 38, 45], GUARD_WAIT_S="600", GUARD_WAIT_INTERVAL_S="0.01")
    assert result.returncode == 0, result.stderr
    waits = [line for line in result.stderr.splitlines() if "waiting for memory" in line]
    assert len(waits) == 2
    assert "35 % free, floor 40 %" in waits[0]
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "1"


def test_a_wait_that_runs_out_refuses(tmp_path):
    result = run(tmp_path, [30], GUARD_WAIT_S="0.03", GUARD_WAIT_INTERVAL_S="0.01")
    assert result.returncode == 1
    assert "refusing to start: 30 % memory free, floor 40 % after waiting" in result.stderr
    assert not (tmp_path / "fake" / "attempt").exists()


def test_a_swap_guard_stop_fails_the_run_without_retries(tmp_path):
    result = run(tmp_path, [50], HANG_ATTEMPT="1")
    assert result.returncode == 1
    summary = (tmp_path / "out" / "logs" / "pfaedle-t.summary").read_text()
    assert "guard_stop swap grew from 1000 MB to 5000 MB" in summary
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "1"


def test_a_swap_guard_stop_is_retried_once_memory_is_back_and_the_retry_passes(tmp_path):
    result = run(
        tmp_path,
        [50, 50, 50, 50, 30, 45],
        HANG_ATTEMPT="1",
        GUARD_RETRIES="1",
        GUARD_WAIT_S="600",
        GUARD_WAIT_INTERVAL_S="0.01",
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "2"
    summary = (tmp_path / "out" / "logs" / "pfaedle-t.summary").read_text()
    assert "retry 1 of 1 after guard stop: swap grew from 1000 MB to 5000 MB" in summary
    assert summary.rstrip().endswith("guard_stop none")
    assert "exit_status 0" in summary
    logs = tmp_path / "out" / "logs"
    assert (logs / "pfaedle-t.attempt-1.log").read_text().strip() == "pfaedle attempt 1"
    assert (logs / "pfaedle-t.log").read_text().strip() == "pfaedle attempt 2"
    assert any("waiting for memory" in line for line in result.stderr.splitlines())


def test_retries_run_out_after_the_last_guard_stop(tmp_path):
    result = run(tmp_path, [50], HANG_ATTEMPT="1", GUARD_RETRIES="0")
    assert result.returncode == 1


def test_a_retry_keeps_the_first_swap_baseline_and_waits_for_room_or_stops(tmp_path):
    result = run(
        tmp_path,
        [50],
        HANG_ATTEMPT="1",
        GUARD_RETRIES="1",
        SWAP_AFTER_STOP="3000",
        GUARD_WAIT_S="0.03",
        GUARD_WAIT_INTERVAL_S="0.01",
    )
    assert result.returncode == 1
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "1"
    summary = (tmp_path / "out" / "logs" / "pfaedle-t.summary").read_text()
    assert "swap_baseline_mb 1000" in summary
    assert "no retry: swap 3000 MB is 2000 MB above the first start, more than 1024 MB" in summary
    logs = tmp_path / "out" / "logs"
    assert (logs / "pfaedle-t.log").exists()
    assert not (logs / "pfaedle-t.attempt-1.log").exists()


def test_a_retry_starts_once_swap_is_back_within_half_the_allowance(tmp_path):
    result = run(
        tmp_path,
        [50],
        HANG_ATTEMPT="1",
        GUARD_RETRIES="1",
        SWAP_AFTER_STOP="1900",
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "2"


def test_a_container_that_exited_0_as_the_guard_fired_is_kept_not_retried(tmp_path):
    result = run(tmp_path, [50], HANG_ATTEMPT="1", GUARD_RETRIES="1", STOP_EXIT="0")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "fake" / "attempt").read_text().strip() == "1"
    summary = (tmp_path / "out" / "logs" / "pfaedle-t.summary").read_text()
    assert "exit_status 0" in summary
    assert "kept: the container had already exited 0" in summary


def fake_proc(tmp_path: Path, available_kb: int, pressure: str | None) -> Path:
    proc = tmp_path / "proc"
    proc.mkdir()
    (proc / "meminfo").write_text(
        f"MemTotal:       1000000 kB\nMemAvailable:   {available_kb} kB\n"
        "SwapTotal:      4194304 kB\nSwapFree:       3170304 kB\n"
    )
    if pressure is not None:
        (proc / "pressure").mkdir()
        (proc / "pressure" / "memory").write_text(pressure)
    return proc


def test_on_linux_it_refuses_below_the_floor_from_proc_meminfo(tmp_path):
    proc = fake_proc(tmp_path, 395000, None)
    result = run(tmp_path, [50], FAKE_UNAME="Linux", PROC_ROOT=str(proc))
    assert result.returncode == 1
    assert "refusing to start: 39 % memory free, floor 40 %" in result.stderr
    assert not (tmp_path / "fake" / "attempt").exists()


@pytest.mark.parametrize(
    ("stalls", "level"),
    [(None, "1"), ((0.0, 0.0), "1"), ((12.5, 2.0), "2"), ((60.0, 25.0), "4")],
)
def test_on_linux_it_reads_swap_free_memory_and_pressure_from_proc(tmp_path, stalls, level):
    pressure = None
    if stalls is not None:
        pressure = "".join(
            f"{kind} avg10={avg10:.2f} avg60=0.00 avg300=0.00 total=0\n"
            for kind, avg10 in zip(("some", "full"), stalls, strict=True)
        )
    proc = fake_proc(tmp_path, 550000, pressure)
    result = run(tmp_path, [50], FAKE_UNAME="Linux", PROC_ROOT=str(proc))
    summary = (tmp_path / "out" / "logs" / "pfaedle-t.summary").read_text()
    assert f"swap_used_mb 1000 free_percent 55 pressure_level {level}" in summary
    if level == "4":
        assert result.returncode == 1
        assert "guard_stop memory pressure critical" in summary
    else:
        assert result.returncode == 0, result.stderr
        assert "guard_stop none" in summary


@pytest.mark.parametrize(("signal", "code"), [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_a_killed_run_stops_saves_the_log_and_removes_its_container(tmp_path, signal, code):
    environ = prepare(tmp_path, [50], {"HANG_FOREVER": "1", "GUARD_INTERVAL_S": "5"})
    process = subprocess.Popen(  # noqa: S603
        ["bash", str(SCRIPT), "t", str(tmp_path / "de.osm.pbf")],  # noqa: S607
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environ,
    )
    samples = tmp_path / "out" / "logs" / "pfaedle-t.mem.csv"
    deadline = time.monotonic() + 20
    while (
        time.monotonic() < deadline
        and len(samples.read_text().splitlines() if samples.exists() else []) < 2
    ):
        time.sleep(0.05)
    started = time.monotonic()
    process.send_signal(signal)
    process.communicate(timeout=20)
    assert time.monotonic() - started < 3
    assert process.returncode == code
    calls = (tmp_path / "fake" / "calls").read_text().split()
    assert calls[-3:] == ["stop", "logs", "rm"]
    logs = tmp_path / "out" / "logs"
    assert (logs / "pfaedle-t.log").read_text().strip() == "pfaedle attempt 1"
    assert "interrupted, container stopped and removed" in (logs / "pfaedle-t.summary").read_text()
