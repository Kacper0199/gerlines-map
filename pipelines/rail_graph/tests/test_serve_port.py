"""services/router/scripts/serve.sh refuses a port another server already answers on."""

import http.server
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "services" / "router" / "scripts" / "serve.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("curl") is None, reason="needs bash and curl"
)

MOTIS = """#!/usr/bin/env bash
echo started >"$FAKE/motis-started"
exec sleep 30
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_dir(tmp_path: Path, port: int) -> Path:
    router = tmp_path / "router"
    run = router / "runs" / "new-run"
    (run / "data").mkdir(parents=True)
    config = f'server:\n  host: 127.0.0.1\n  port: "{port}"\n'
    (run / "config.yml").write_text(config)
    (run / "data" / "config.yml").write_text(config)
    motis = tmp_path / "motis"
    motis.write_text(MOTIS)
    motis.chmod(0o755)
    return router


def serve(tmp_path: Path, router: Path):
    environ = {
        "PATH": os.environ["PATH"],
        "FAKE": str(tmp_path),
        "ROUTER_DATA": str(router),
        "GERLINES_INPUTS": str(tmp_path / "inputs"),
        "MOTIS_BIN": str(tmp_path / "motis"),
        "HEALTH_TIMEOUT_S": "2",
    }
    return subprocess.run(  # noqa: S603
        ["/bin/bash", str(SCRIPT), "new-run"],
        capture_output=True,
        text=True,
        env=environ,
        timeout=60,
        check=False,
    )


def test_a_port_that_already_answers_is_refused_before_starting(tmp_path):
    server = http.server.HTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        router = run_dir(tmp_path, server.server_address[1])
        result = serve(tmp_path, router)
    finally:
        server.shutdown()

    assert result.returncode != 0
    assert "already answers" in result.stderr
    assert not (tmp_path / "motis-started").exists()


def test_a_free_port_starts_the_server(tmp_path):
    router = run_dir(tmp_path, free_port())

    result = serve(tmp_path, router)

    assert "already answers" not in result.stderr
    assert (tmp_path / "motis-started").exists()
