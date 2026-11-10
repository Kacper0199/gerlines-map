import pytest

from gerlines_rail_graph import guard
from gerlines_rail_graph.guard import LockHeldError, heavy_lock, hold_locks, require_free_memory


def test_the_lock_names_its_owner_while_held_and_goes_when_the_job_ends(tmp_path):
    lock = tmp_path / "heavy"

    with heavy_lock(lock, "WP-2.2", "gerlines-rail-graph finish"):
        owner = (lock / "owner.txt").read_text().splitlines()
        assert owner[:2] == ["WP-2.2", "gerlines-rail-graph finish"]
        assert owner[2].startswith("started ")

    assert not lock.exists()


def test_the_lock_goes_when_the_job_fails(tmp_path):
    lock = tmp_path / "heavy"

    with pytest.raises(RuntimeError, match="boom"), heavy_lock(lock, "WP-2.2", "x"):
        raise RuntimeError("boom")

    assert not lock.exists()


def test_a_held_lock_is_refused_and_left_to_its_owner(tmp_path):
    lock = tmp_path / "heavy"
    lock.mkdir()
    (lock / "owner.txt").write_text("SP-2\nmotis import\n")

    with pytest.raises(LockHeldError, match="SP-2"), heavy_lock(lock, "WP-2.2", "x"):
        pass

    assert (lock / "owner.txt").read_text().startswith("SP-2")


def test_two_locks_are_taken_in_order_and_the_first_is_released_when_the_second_is_held(
    tmp_path,
):
    heavy, load = tmp_path / "heavy", tmp_path / "db-load"
    load.mkdir()

    with pytest.raises(LockHeldError), hold_locks([heavy, load], "WP-2.2", "load"):
        pass

    assert not heavy.exists()
    assert load.exists()
    load.rmdir()
    with hold_locks([heavy, load], "WP-2.2", "load"):
        assert heavy.exists()
        assert load.exists()
    assert not heavy.exists()
    assert not load.exists()


def test_the_memory_floor_refuses_below_forty_percent(monkeypatch):
    monkeypatch.setattr(guard, "free_percent", lambda: 39)
    with pytest.raises(SystemExit, match="39 % memory free"):
        require_free_memory()
    monkeypatch.setattr(guard, "free_percent", lambda: 55)
    assert require_free_memory() == 55


class Clock:
    def __init__(self):
        self.slept: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)


def readings(*values: int):
    queue = list(values)
    return lambda: queue.pop(0) if len(queue) > 1 else queue[0]


def test_the_memory_floor_refuses_at_once_without_a_wait(monkeypatch):
    monkeypatch.delenv("GUARD_WAIT_S", raising=False)
    monkeypatch.setattr(guard, "free_percent", lambda: 39)
    clock, lines = Clock(), []
    with pytest.raises(SystemExit, match=r"^refusing to start: 39 % memory free, floor 40 %$"):
        require_free_memory(sleep=clock.sleep, log=lines.append)
    assert clock.slept == []
    assert lines == []


def test_a_wait_polls_every_minute_logs_each_wait_and_starts_once_memory_is_back(monkeypatch):
    monkeypatch.setattr(guard, "free_percent", readings(35, 39, 41))
    clock, lines = Clock(), []
    free = require_free_memory(wait_s=3600, sleep=clock.sleep, log=lines.append)
    assert free == 41
    assert clock.slept == [60, 60]
    assert lines == [
        "waiting for memory: 35 % free, floor 40 %, waited 0 of 3600 s",
        "waiting for memory: 39 % free, floor 40 %, waited 60 of 3600 s",
    ]


def test_a_wait_that_runs_out_refuses_and_says_how_long_it_waited(monkeypatch):
    monkeypatch.setattr(guard, "free_percent", lambda: 39)
    clock, lines = Clock(), []
    with pytest.raises(SystemExit, match="39 % memory free, floor 40 % after waiting 150 s"):
        require_free_memory(wait_s=150, sleep=clock.sleep, log=lines.append)
    assert clock.slept == [60, 60, 30]
    assert len(lines) == 3


def test_the_wait_and_its_interval_come_from_the_environment_for_runbook_chains(monkeypatch):
    monkeypatch.setenv("GUARD_WAIT_S", "90")
    monkeypatch.setenv("GUARD_WAIT_INTERVAL_S", "30")
    monkeypatch.setattr(guard, "free_percent", readings(20, 20, 50))
    clock = Clock()
    assert require_free_memory(sleep=clock.sleep, log=lambda _: None) == 50
    assert clock.slept == [30, 30]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("GUARD_WAIT_S", "soon"),
        ("GUARD_WAIT_INTERVAL_S", "0"),
        ("GUARD_WAIT_S", "nan"),
        ("GUARD_WAIT_S", "inf"),
        ("GUARD_WAIT_S", "-inf"),
        ("GUARD_WAIT_INTERVAL_S", "nan"),
        ("GUARD_WAIT_INTERVAL_S", "inf"),
    ],
)
def test_a_wait_setting_that_is_not_a_positive_number_is_refused(monkeypatch, name, value):
    monkeypatch.setenv("GUARD_WAIT_S", "60")
    monkeypatch.setenv(name, value)
    monkeypatch.setattr(guard, "free_percent", lambda: 10)
    with pytest.raises(SystemExit, match=name):
        require_free_memory(sleep=lambda _: None, log=lambda _: None)
