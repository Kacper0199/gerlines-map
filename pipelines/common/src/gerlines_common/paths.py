"""Locations of the repository root and its git-ignored data folders."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT_MARKER = "pnpm-workspace.yaml"
ROOT_OVERRIDE = "GERLINES_ROOT"


class ProjectRootNotFoundError(FileNotFoundError):
    """The repository root could not be located."""


@dataclass(frozen=True, slots=True)
class ProjectPaths:
    root: Path

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def raw(self) -> Path:
        return self.root / "raw"

    @property
    def recordings(self) -> Path:
        return self.data / "recordings"


def find_project_root(start: Path, environ: Mapping[str, str] = os.environ) -> Path:
    """Return ``GERLINES_ROOT`` when set, else the nearest ancestor of ``start`` with the marker."""
    override = environ.get(ROOT_OVERRIDE)
    if override:
        root = Path(override)
        if not root.is_dir():
            msg = f"{ROOT_OVERRIDE} points to {root}, which is not a directory"
            raise ProjectRootNotFoundError(msg)
        return root
    resolved = start.resolve()
    for candidate in (resolved, *resolved.parents):
        if (candidate / ROOT_MARKER).is_file():
            return candidate
    msg = f"no {ROOT_MARKER} found in {resolved} or its parents; set {ROOT_OVERRIDE}"
    raise ProjectRootNotFoundError(msg)


def project_paths(root: Path | None = None) -> ProjectPaths:
    """Paths for ``root``, or for the repository that contains the working directory."""
    return ProjectPaths(root if root is not None else find_project_root(Path.cwd()))
