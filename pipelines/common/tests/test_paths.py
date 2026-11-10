from pathlib import Path

import pytest

from gerlines_common.paths import ProjectRootNotFoundError, find_project_root, project_paths


def make_workspace(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "pipelines" / "common").mkdir(parents=True)
    (root / "pnpm-workspace.yaml").write_text("packages: []\n")
    return root


def test_finds_root_from_nested_directory(tmp_path: Path) -> None:
    root = make_workspace(tmp_path)
    assert find_project_root(root / "pipelines" / "common", environ={}) == root


def test_environment_override_wins(tmp_path: Path) -> None:
    root = make_workspace(tmp_path)
    other = tmp_path / "elsewhere"
    other.mkdir()
    assert find_project_root(root, environ={"GERLINES_ROOT": str(other)}) == other


def test_environment_override_must_exist(tmp_path: Path) -> None:
    with pytest.raises(ProjectRootNotFoundError, match="GERLINES_ROOT"):
        find_project_root(tmp_path, environ={"GERLINES_ROOT": str(tmp_path / "missing")})


def test_fails_outside_a_workspace(tmp_path: Path) -> None:
    with pytest.raises(ProjectRootNotFoundError, match=r"pnpm-workspace\.yaml"):
        find_project_root(tmp_path, environ={})


def test_project_paths_follow_the_documented_layout(tmp_path: Path) -> None:
    root = make_workspace(tmp_path)
    paths = project_paths(root)
    assert paths.root == root
    assert paths.data == root / "data"
    assert paths.raw == root / "raw"
    assert paths.recordings == root / "data" / "recordings"


def test_finds_this_repository() -> None:
    root = find_project_root(Path(__file__).parent, environ={})
    assert (root / "pipelines" / "common" / "pyproject.toml").is_file()
