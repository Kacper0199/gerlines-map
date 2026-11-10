"""The shared heavy-job lock and the free-memory floor (development notes, shared rules).

The lock is a folder: ``mkdir`` is atomic, so only one heavy job holds it; ``owner.txt`` inside
names the holder. It is removed when the job ends, also when it fails.

Below the floor a step refuses at once, unless ``GUARD_WAIT_S`` gives it a wait: it then polls every
``GUARD_WAIT_INTERVAL_S`` (60) seconds, logs each wait to stderr and refuses only when the wait ran
out (runbook chains set it, so a dip below the floor does not end the chain).
"""

import math
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from pathlib import Path

FREE_FLOOR_PERCENT = 40
WAIT_INTERVAL_S = 60


def free_percent() -> int | None:
    """System-wide free memory in percent from macOS ``memory_pressure``, None elsewhere."""
    tool = shutil.which("memory_pressure")
    if tool is None:
        return None
    try:
        text = subprocess.run(  # noqa: S603
            [tool], capture_output=True, text=True, timeout=30, check=True
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r"free percentage:\s*(\d+)%", text)
    return int(found.group(1)) if found else None


class LockHeldError(RuntimeError):
    pass


@contextmanager
def heavy_lock(lock: Path, owner: str, command: str) -> Iterator[None]:
    """Holds ``lock`` for the duration; refuses when another job holds it."""
    try:
        lock.mkdir(parents=False)
    except FileExistsError as error:
        holder = lock / "owner.txt"
        text = holder.read_text().strip() if holder.exists() else "unknown"
        msg = f"heavy lock {lock} is held: {text}"
        raise LockHeldError(msg) from error
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (lock / "owner.txt").write_text(f"{owner}\n{command}\nstarted {stamp}\n")
        yield
    finally:
        shutil.rmtree(lock, ignore_errors=True)


@contextmanager
def hold_locks(locks: Sequence[Path], owner: str, command: str) -> Iterator[None]:
    """Holds every lock in order (the heavy lock, then ``db-load`` for a load); one held by
    another job releases those already taken."""
    with ExitStack() as stack:
        for lock in locks:
            stack.enter_context(heavy_lock(lock, owner, command))
        yield


def _env_seconds(name: str, default: float, *, positive: bool) -> float:
    text = os.environ.get(name, "").strip()
    if not text:
        return default
    try:
        value = float(text)
    except ValueError:
        value = -1.0
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        kind = "positive" if positive else "non-negative"
        msg = f"{name} must be a {kind} number of seconds, got {text!r}"
        raise SystemExit(msg)
    return value


def _stderr(line: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"{stamp} {line}", file=sys.stderr, flush=True)


def require_free_memory(
    floor: int = FREE_FLOOR_PERCENT,
    *,
    wait_s: float | None = None,
    interval_s: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = _stderr,
) -> int | None:
    """The free memory in percent once it reaches ``floor``; refuses at once without a wait."""
    limit = _env_seconds("GUARD_WAIT_S", 0, positive=False) if wait_s is None else wait_s
    interval = (
        _env_seconds("GUARD_WAIT_INTERVAL_S", WAIT_INTERVAL_S, positive=True)
        if interval_s is None
        else interval_s
    )
    waited = 0.0
    while True:
        free = free_percent()
        if free is None or free >= floor:
            return free
        if waited >= limit:
            after = f" after waiting {waited:.0f} s" if waited else ""
            msg = f"refusing to start: {free} % memory free, floor {floor} %{after}"
            raise SystemExit(msg)
        state = f"{free} % free, floor {floor} %"
        log(f"waiting for memory: {state}, waited {waited:.0f} of {limit:.0f} s")
        pause = min(interval, limit - waited)
        sleep(pause)
        waited += pause
