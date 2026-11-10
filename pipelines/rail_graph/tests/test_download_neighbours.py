"""services/router/scripts/download-neighbours.sh with a stand-in for curl on PATH."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "services"
    / "router"
    / "scripts"
    / "download-neighbours.sh"
)

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("jq") is None, reason="needs bash and jq"
)

CURL = r"""#!/usr/bin/env bash
url="${@: -1}"
for arg in "$@"; do
  if [[ "$arg" == "--head" ]]; then
    printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n' "$FAKE_BYTES"
    printf 'Last-Modified: Sun, 08 Nov 2026 00:00:00 GMT\r\n\r\n'
    exit 0
  fi
done
echo "GET $url" >>"$FAKE/gets"
out=""
while (($#)); do
  [[ "$1" == "--output" ]] && out="$2"
  shift
done
if [[ -n "$out" ]]; then printf 'x' >"$out"; else echo "9dd4e461268c8034f5c8564e155c67a6  file"; fi
"""


def run(tmp_path: Path, regions: list[str], **env: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "curl").write_text(CURL)
    (bin_dir / "curl").chmod(0o755)
    listing = tmp_path / "regions.txt"
    listing.write_text(
        "# test\n" + "".join(f"{r} https://example.test/{r}.osm.pbf\n" for r in regions)
    )
    path = os.pathsep.join(
        [str(bin_dir), str(Path(shutil.which("jq")).parent), "/usr/bin", "/bin", "/sbin"]
    )
    environ = {
        "PATH": path,
        "FAKE": str(tmp_path),
        "USER_AGENT": "gerlines-test/0 (+test)",
        "ROUTER_DATA": str(tmp_path / "router"),
        "GERLINES_INPUTS": str(tmp_path / "inputs"),
        **env,
    }
    return subprocess.run(  # noqa: S603
        ["/bin/bash", str(SCRIPT), str(tmp_path / "out"), str(listing)],
        capture_output=True,
        text=True,
        env=environ,
        timeout=60,
        check=False,
    )


def test_a_set_above_the_cap_stops_before_any_download(tmp_path):
    result = run(tmp_path, ["a", "b"], FAKE_BYTES="4000000000")

    assert result.returncode != 0
    assert "nothing downloaded" in result.stderr
    assert not (tmp_path / "gets").exists()
    assert not list((tmp_path / "out").glob("*.part"))


def test_a_set_within_the_cap_is_fetched_and_checked(tmp_path):
    result = run(tmp_path, ["a"], FAKE_BYTES="1")

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "out" / "a.osm.pbf").read_text() == "x"
    assert (tmp_path / "out" / "a.osm.pbf.json").exists()
