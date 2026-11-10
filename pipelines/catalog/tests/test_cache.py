import json
import urllib.request
from pathlib import Path

from gerlines_catalog.cache import ResearchCache


class FakeTransport:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, _timeout: float) -> bytes:
        self.requests.append(request)
        return self.body


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def make_cache(root: Path, transport: FakeTransport, clock: FakeClock) -> ResearchCache:
    return ResearchCache(
        root,
        "GerLines/test (+mailto:someone@example.org)",
        transport=transport,
        min_interval_s=2.0,
        clock=clock,
        sleep=clock.sleep,
    )


def test_a_cached_body_is_reused_and_the_sidecar_hides_the_user_agent(tmp_path: Path) -> None:
    transport = FakeTransport(b'{"ok": true}')
    clock = FakeClock()
    cache = make_cache(tmp_path, transport, clock)
    first = cache.post_form("wikidata", "q.json", "https://example.org/sparql", {"query": "Q"},
                            licence="CC0-1.0", accept="application/json")  # fmt: skip
    second = cache.post_form("wikidata", "q.json", "https://example.org/sparql", {"query": "Q"},
                             licence="CC0-1.0", accept="application/json")  # fmt: skip
    assert not first.reused
    assert second.reused
    assert len(transport.requests) == 1
    assert transport.requests[0].get_header("User-agent").startswith("GerLines/test")
    sidecar = (tmp_path / "wikidata" / "q.json.meta.json").read_text()
    assert "someone@example.org" not in sidecar
    assert json.loads(sidecar)["licence"] == "CC0-1.0"


def test_another_request_body_is_fetched_again(tmp_path: Path) -> None:
    transport = FakeTransport(b"x")
    clock = FakeClock()
    cache = make_cache(tmp_path, transport, clock)
    cache.post_form("w", "a", "https://example.org", {"query": "A"}, licence="CC0-1.0", accept="*")
    cache.post_form("w", "a", "https://example.org", {"query": "B"}, licence="CC0-1.0", accept="*")
    assert len(transport.requests) == 2
    assert clock.slept == [2.0]


def test_a_changed_body_on_disk_is_fetched_again(tmp_path: Path) -> None:
    transport = FakeTransport(b"original")
    cache = make_cache(tmp_path, transport, FakeClock())
    cache.get("u", "file.csv", "https://example.org/file.csv", licence="CC0-1.0")
    (tmp_path / "u" / "file.csv").write_bytes(b"tampered")
    again = cache.get("u", "file.csv", "https://example.org/file.csv", licence="CC0-1.0")
    assert not again.reused
    assert again.body == b"original"
