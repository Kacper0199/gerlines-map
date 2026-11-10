"""Seed models: one pydantic model per seed file row, strict, with no unknown keys.

Every row names the source of its values (``source``) and may name another source per field
(``field_sources``); a value nobody published stays ``None`` and, where a field asks for it,
carries the reason in ``missing``.
"""

import re
from datetime import date
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, HttpUrl, model_validator

SLUG = r"^[a-z][a-z0-9-]{1,62}$"
QID = r"^Q[1-9]\d*$"
HEX = r"^#[0-9a-f]{6}$"
KNOWN_LICENCES = frozenset(
    {
        "CC0-1.0", "CC-BY-2.0", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-2.0", "CC-BY-SA-2.0-DE",
        "CC-BY-SA-3.0", "CC-BY-SA-3.0-DE", "CC-BY-SA-4.0", "ODbL-1.0", "DL-DE-BY-2.0",
        "DL-DE-ZERO-2.0",
    }
)  # fmt: skip
STATIC_IMPORT_ALIAS_SOURCES = frozenset({"delfi-gtfs", "traines-delfi-eva"})
LICENCE_REF = re.compile(r"^LicenseRef-[A-Za-z0-9.-]+$")
LAENDER = (
    "DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV",
    "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH",
)  # fmt: skip

Slug = Annotated[str, Field(pattern=SLUG)]
Qid = Annotated[str, Field(pattern=QID)]
Hex = Annotated[str, Field(pattern=HEX)]
Land = Literal[
    "DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV",
    "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH",
]  # fmt: skip
Country = Annotated[str, Field(pattern=r"^[A-Z]{2}$")]


def _not_blank(text: str) -> str:
    if not text.strip() or text != text.strip():
        msg = "must be non-empty without leading or trailing spaces"
        raise ValueError(msg)
    return text


Text = Annotated[str, AfterValidator(_not_blank)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=False)


class Sourced(Strict):
    source: Slug
    field_sources: dict[str, Slug] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _field_sources_name_fields(self) -> "Sourced":
        unknown = set(self.field_sources) - set(type(self).model_fields)
        if unknown:
            msg = f"field_sources names unknown fields: {sorted(unknown)}"
            raise ValueError(msg)
        return self

    def source_of(self, field: str) -> str:
        return self.field_sources.get(field, self.source)

    def referenced_sources(self) -> set[str]:
        return {self.source, *self.field_sources.values()}


class Source(Strict):
    source_id: Slug
    name: Text
    homepage_url: HttpUrl
    licence: Text
    licence_url: HttpUrl
    attribution: Text
    note: Text | None = None

    @model_validator(mode="after")
    def _licence_is_spdx_expression(self) -> "Source":
        for token in self.licence.replace("(", " ").replace(")", " ").split():
            if token in {"AND", "OR"} or token in KNOWN_LICENCES or LICENCE_REF.match(token):
                continue
            msg = f"licence {self.licence!r} is not an SPDX expression of known licences"
            raise ValueError(msg)
        return self


class Names(Strict):
    en: Text
    de: Text
    pl: Text


class Category(Sourced):
    code: Annotated[str, Field(pattern=r"^[a-z]{2,16}$")]
    name: Names
    sort_order: Annotated[int, Field(ge=1, le=32767)]


class WikidataRole(StrEnum):
    COMPANY = "company"
    PARENT_COMPANY = "parent_company"
    BRAND = "brand"
    NETWORK = "network"


class Alias(Strict):
    alias: Text
    valid_from: date | None = None
    valid_to: date | None = None
    source: Slug

    @model_validator(mode="after")
    def _dates_in_order(self) -> "Alias":
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            msg = f"alias {self.alias!r} ends before it starts"
            raise ValueError(msg)
        return self


class Parent(Strict):
    name: Text
    wikidata_qid: Qid | None = None


class Operator(Sourced):
    operator_id: Slug
    feed_name: Text
    brand_name: Text
    legal_name: Text | None = None
    country: Country | None = None
    wikidata_qid: Qid | None = None
    wikidata_role: WikidataRole | None = None
    wikidata_basis: Slug | None = None
    website: HttpUrl | None = None
    parents: list[Parent] = Field(default_factory=list)
    valid_from: date | None = None
    valid_to: date | None = None
    aliases: list[Alias] = Field(default_factory=list)
    missing: dict[str, Text] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _wikidata_complete_or_explained(self) -> "Operator":
        if self.wikidata_qid is None:
            if "wikidata_qid" not in self.missing:
                msg = f"{self.operator_id}: no wikidata_qid and no reason in missing"
                raise ValueError(msg)
            if self.wikidata_role or self.wikidata_basis:
                msg = f"{self.operator_id}: wikidata_role or basis without wikidata_qid"
                raise ValueError(msg)
        elif not (self.wikidata_role and self.wikidata_basis):
            msg = f"{self.operator_id}: wikidata_qid needs wikidata_role and wikidata_basis"
            raise ValueError(msg)
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            msg = f"{self.operator_id}: valid_to before valid_from"
            raise ValueError(msg)
        if self.wikidata_role is WikidataRole.PARENT_COMPANY and (self.legal_name or self.aliases):
            msg = (
                f"{self.operator_id}: the item is the parent company, its names are not the"
                " operator's legal name or aliases"
            )
            raise ValueError(msg)
        reserved = sorted({a.source for a in self.aliases} & STATIC_IMPORT_ALIAS_SOURCES)
        if reserved:
            msg = f"{self.operator_id}: alias source {reserved} belongs to the static import"
            raise ValueError(msg)
        return self

    def referenced_sources(self) -> set[str]:
        found = super().referenced_sources() | {a.source for a in self.aliases}
        if self.wikidata_basis:
            found.add(self.wikidata_basis)
        return found


class Verbund(Sourced):
    verbund_id: Slug
    abbr: Text
    name: Text
    laender: list[Land] = Field(min_length=1)
    spnv_integrated: bool | None = None
    wikidata_qid: Qid | None = None
    website: HttpUrl | None = None
    missing: dict[str, Text] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _unknowns_explained(self) -> "Verbund":
        for field in ("spnv_integrated", "wikidata_qid"):
            if getattr(self, field) is None and field not in self.missing:
                msg = f"{self.verbund_id}: {field} is empty without a reason in missing"
                raise ValueError(msg)
        if sorted(set(self.laender)) != list(self.laender):
            msg = f"{self.verbund_id}: laender must be sorted and unique"
            raise ValueError(msg)
        return self


class Traction(StrEnum):
    ELECTRIC = "electric"
    DIESEL = "diesel"
    BATTERY_ELECTRIC = "battery_electric"
    HYDROGEN = "hydrogen"
    DUAL_MODE = "dual_mode"


class UnitKind(StrEnum):
    EMU = "emu"
    DMU = "dmu"
    LOCOMOTIVE = "locomotive"
    COACH = "coach"
    TRAINSET = "trainset"
    TRAM_TRAIN = "tram_train"


class Priority(StrEnum):
    P1 = "P1"
    P2 = "P2"
    P3 = "P3"


SERIES_EXPLAINED_FIELDS = (
    "wikidata_qid", "max_speed_kmh", "unit_length_m", "family", "traction", "unit_kind",
    "double_deck", "cars_min", "cars_max",
)  # fmt: skip


class VehicleSeries(Sourced):
    series_id: Slug
    name: Text
    br: Text | None = None
    family: Text | None = None
    manufacturers: list[Text] = Field(default_factory=list)
    traction: Traction | None = None
    unit_kind: UnitKind | None = None
    double_deck: bool | None = None
    cars_min: Annotated[int, Field(ge=1, le=40)] | None = None
    cars_max: Annotated[int, Field(ge=1, le=40)] | None = None
    unit_length_m: Annotated[float, Field(gt=5, lt=500)] | None = None
    max_speed_kmh: Annotated[int, Field(ge=20, le=400)] | None = None
    priority: Priority
    operators: list[Slug] = Field(default_factory=list)
    wikidata_qid: Qid | None = None
    commons_category: Text | None = None
    dewiki_title: Text | None = None
    missing: dict[str, Text] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _cars_in_order(self) -> "VehicleSeries":
        if self.cars_min and self.cars_max and self.cars_max < self.cars_min:
            msg = f"{self.series_id}: cars_max below cars_min"
            raise ValueError(msg)
        for field in SERIES_EXPLAINED_FIELDS:
            empty = getattr(self, field) is None
            if empty and field not in self.missing:
                msg = f"{self.series_id}: {field} is empty without a reason in missing"
                raise ValueError(msg)
            if not empty and field in self.missing:
                msg = f"{self.series_id}: {field} has a value and a reason in missing"
                raise ValueError(msg)
        return self


class IdenticalBody(Sourced):
    """A pair of series that may share one 3D model because their car bodies are the same.

    ``series_id`` has no forge model, ``related_series_id`` has one; a ``rejected`` row records a
    pair that was examined and does not hold, so nobody has to research it again.
    """

    series_id: Slug
    related_series_id: Slug
    verdict: Literal["accepted", "rejected"]
    evidence: Text
    reason: Text


class LiveryColour(Strict):
    role: Literal[
        "body", "upper_body", "lower_body", "window_band", "stripe", "doors", "accent",
        "mask", "skirt", "roof",
    ]  # fmt: skip
    name: Text
    ral: Annotated[str, Field(pattern=r"^RAL \d{4}$")] | None = None
    hex: Hex | None = None
    source: Slug
    hex_source: Slug | None = None

    @model_validator(mode="after")
    def _hex_cited(self) -> "LiveryColour":
        if (self.hex is None) != (self.hex_source is None):
            msg = f"colour {self.name!r}: hex and hex_source go together"
            raise ValueError(msg)
        return self


class Livery(Sourced):
    livery_id: Slug
    name: Text
    operator_id: Slug | None = None
    series_ids: list[Slug] = Field(default_factory=list)
    also_operator_ids: list[Slug] = Field(default_factory=list)
    lines: list[Text] = Field(default_factory=list)
    valid_from: date | None = None
    valid_to: date | None = None
    colours: list[LiveryColour] = Field(default_factory=list)
    missing: dict[str, Text] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _valid_days_in_order(self) -> "Livery":
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            msg = f"{self.livery_id}: valid_to before valid_from"
            raise ValueError(msg)
        if self.lines and not self.operator_id:
            msg = f"{self.livery_id}: lines need an operator_id"
            raise ValueError(msg)
        if self.also_operator_ids and not self.operator_id:
            msg = f"{self.livery_id}: also_operator_ids need an operator_id"
            raise ValueError(msg)
        if self.operator_id and self.operator_id in self.also_operator_ids:
            msg = f"{self.livery_id}: also_operator_ids names its own operator"
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def _colours_or_reason(self) -> "Livery":
        if not self.colours and "colours" not in self.missing:
            msg = f"{self.livery_id}: no colours and no reason in missing"
            raise ValueError(msg)
        return self

    def referenced_sources(self) -> set[str]:
        return super().referenced_sources() | {
            s for c in self.colours for s in (c.source, c.hex_source) if s
        }


class LineShape(StrEnum):
    CIRCLE = "circle"
    HEXAGON = "hexagon"
    RECTANGLE = "rectangle"
    RECTANGLE_ROUNDED_CORNER = "rectangle-rounded-corner"
    PILL = "pill"
    TRAPEZOID = "trapezoid"


class LineColour(Strict):
    line_colour_id: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,200}$")]
    upstream_operator: Text
    line_name: Text
    delfi_agency_key: Text | None = None
    delfi_agency_name: Text | None = None
    operator_id: Slug | None = None
    background_hex: Hex
    text_hex: Hex
    border_hex: Hex | None = None
    shape: LineShape
    line_wikidata_qid: Qid | None = None
    source: Slug
