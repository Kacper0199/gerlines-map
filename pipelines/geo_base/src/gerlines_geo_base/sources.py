"""Upstream datasets, their licences and the attribution each output must carry."""

from dataclasses import dataclass

BKG_ATTRIBUTION = "© GeoBasis-DE / BKG (2026)"
BKG_CHANGE_NOTE = (
    "Changed by GerLines: land areas only, reprojected to WGS 84, simplified with shared borders "
    "kept, coordinates rounded"
)
NATURAL_EARTH_ATTRIBUTION = "Made with Natural Earth"


@dataclass(frozen=True, slots=True)
class Source:
    key: str
    url: str
    filename: str
    licence: str
    attribution: str
    edition: str
    sha256: str
    md5_url: str | None = None


_BKG = "https://daten.gdz.bkg.bund.de/produkte/vg"
_NE = "https://naciscdn.org/naturalearth/10m/cultural"

VG250 = Source(
    key="bkg-vg250",
    url=f"{_BKG}/vg250_ebenen_0101/2026/vg250_01-01.utm32s.gpkg.ebenen.zip",
    filename="vg250_01-01.utm32s.gpkg.ebenen.zip",
    licence="DL-DE-BY-2.0",
    attribution=BKG_ATTRIBUTION,
    edition="VG250 Ebenen, Stand 2026-01-01",
    sha256="6b096eb4862b4eafda9294e425fb5a6d0e7773eb5815a4d4edc78b639ec2728f",
    md5_url=f"{_BKG}/vg250_ebenen_0101/2026/vg250_01-01.utm32s.gpkg.ebenen.zip.md5",
)

NE_COUNTRIES = Source(
    key="ne-admin0",
    url=f"{_NE}/ne_10m_admin_0_countries.zip",
    filename="ne_10m_admin_0_countries.zip",
    licence="LicenseRef-NaturalEarth-PublicDomain",
    attribution=NATURAL_EARTH_ATTRIBUTION,
    edition="Natural Earth 10m admin 0 countries, 5.1.1",
    sha256="ce1ac7036499a0edd641fbc093cd209a98f96a49d2eca8480aaacad35138a7f6",
)

NE_STATES = Source(
    key="ne-admin1",
    url=f"{_NE}/ne_10m_admin_1_states_provinces.zip",
    filename="ne_10m_admin_1_states_provinces.zip",
    licence="LicenseRef-NaturalEarth-PublicDomain",
    attribution=NATURAL_EARTH_ATTRIBUTION,
    edition="Natural Earth 10m admin 1 states and provinces, 5.1.1",
    sha256="efc59726337323058f9446210adc96673179cd344e053666ee3d28cb58ba2b05",
)

NE_RAILROADS = Source(
    key="ne-railroads",
    url=f"{_NE}/ne_10m_railroads.zip",
    filename="ne_10m_railroads.zip",
    licence="LicenseRef-NaturalEarth-PublicDomain",
    attribution=NATURAL_EARTH_ATTRIBUTION,
    edition="Natural Earth 10m railroads, 5.0.0",
    sha256="0bce64d1bb7ce1178810f0a341322b0459acb0689a61016259ef38f75abed0a4",
)

ALL_SOURCES = (VG250, NE_COUNTRIES, NE_STATES, NE_RAILROADS)
