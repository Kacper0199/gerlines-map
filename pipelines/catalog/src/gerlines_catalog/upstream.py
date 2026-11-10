"""Upstream files the catalogue is built from, pinned to a commit so a rerun gets the same bytes."""

from dataclasses import dataclass

from gerlines_catalog.cache import CachedBody, FetchError, ResearchCache, sha256_hex


@dataclass(frozen=True, slots=True)
class UpstreamFile:
    key: str
    repository: str
    commit: str
    path: str
    licence: str
    sha256: str

    @property
    def url(self) -> str:
        return f"https://raw.githubusercontent.com/{self.repository}/{self.commit}/{self.path}"

    @property
    def page_url(self) -> str:
        return f"https://github.com/{self.repository}/blob/{self.commit}/{self.path}"


LINE_COLOURS = UpstreamFile(
    key="traewelling-line-colors",
    repository="Traewelling/line-colors",
    commit="1bb30909dda42e19214ca90470e0c5dc86cbc6ed",
    path="line-colors.csv",
    licence="CC0-1.0",
    sha256="ba135ca349a36f14b7e2acbd03137bc0d4b3bd575212b8330e38242715ddede9",
)
OPERATOR_MAPPING = UpstreamFile(
    key="traewelling-operator-matching",
    repository="Traewelling/transitous-wikidata-operator-matching",
    commit="7f63ac5a401345c4439a9217d86c9fdf314dd0dc",
    path="mapping.csv",
    licence="CC0-1.0",
    sha256="a1115e826519c83b0abf4fde6acb7bdf336f050508c95aa3ada03ffb1122a79e",
)
UPSTREAM_FILES = (LINE_COLOURS, OPERATOR_MAPPING)


def fetch(cache: ResearchCache, upstream: UpstreamFile, *, refresh: bool = False) -> CachedBody:
    name = f"{upstream.commit[:12]}-{upstream.path.replace('/', '_')}"
    cached = cache.get(upstream.key, name, upstream.url, licence=upstream.licence, refresh=refresh)
    if upstream.sha256 and sha256_hex(cached.body) != upstream.sha256:
        msg = f"{upstream.url} has SHA-256 {sha256_hex(cached.body)}, expected {upstream.sha256}"
        raise FetchError(msg)
    return cached
