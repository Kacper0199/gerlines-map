"""Geometry seeds of ``catalog/vehicles.yaml`` for the vehicle forge (``tools/trainforge``).

A vehicle model is the car sequence of one typical unit of a series (or a generic model of a
category) and the car types it uses. Every measure names its source (``source`` and
``field_sources``) or stays ``None`` with the reason in ``missing``; the forge then falls back to
a stylisation default and lists the field as estimated in the glTF extras.
"""

import itertools
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from gerlines_catalog.models import Slug, Sourced, Strict, Text

UNIT_LENGTH_TOLERANCE_M = 0.25


class CarRole(StrEnum):
    CAB = "cab"
    MIDDLE = "middle"
    POWER_HEAD = "power_head"
    LOCOMOTIVE = "locomotive"
    COACH = "coach"
    DRIVING_TRAILER = "driving_trailer"
    RAILCAR = "railcar"


NOSE_ROLES = frozenset(
    {
        CarRole.CAB,
        CarRole.POWER_HEAD,
        CarRole.LOCOMOTIVE,
        CarRole.DRIVING_TRAILER,
        CarRole.RAILCAR,
    }
)


class BogieKind(StrEnum):
    OWN = "own"
    JACOBS = "jacobs"


class NoseShape(StrEnum):
    STREAMLINED = "streamlined"
    WEDGE = "wedge"
    ROUNDED = "rounded"
    BLUNT = "blunt"
    CAB_CAR = "cab_car"
    LOCOMOTIVE = "locomotive"


Length = Annotated[float, Field(gt=5, lt=40)]
Width = Annotated[float, Field(gt=2, lt=3.6)]
Height = Annotated[float, Field(gt=2.5, lt=5.5)]
Level = Annotated[float, Field(gt=0.1, lt=5)]
Pitch = Annotated[float, Field(gt=2, lt=30)]
Offset = Annotated[float, Field(gt=-5, lt=5)]
Wheelbase = Annotated[float, Field(gt=1.5, lt=3.5)]
Wheel = Annotated[float, Field(gt=0.5, lt=1.4)]
NoseLength = Annotated[float, Field(gt=0.2, lt=14)]
DoorWidth = Annotated[float, Field(gt=0.5, lt=2.2)]
Fraction = Annotated[float, Field(gt=0, le=1)]
Setback = Annotated[float, Field(ge=0, lt=14)]

ALWAYS_EXPLAINED = (
    "length_m", "width_m", "height_m", "floor_height_m", "wheel_diameter_m", "doors_per_side",
    "door_positions_m", "window_sill_m", "window_top_m", "pantograph_count",
)  # fmt: skip


class NoseLoft(Strict):
    """Sections of the nose that narrow towards the tip to a superellipse round the waist."""

    waist_m: Level
    top_m: Level
    bottom_m: Annotated[float, Field(ge=0, lt=5)]
    exponent: Annotated[float, Field(ge=1, le=12)]
    taper: Annotated[float, Field(gt=0, le=6)]
    widths: list[tuple[Annotated[float, Field(ge=0, lt=5)], Fraction]] | None = None

    @model_validator(mode="after")
    def _ordered(self) -> "NoseLoft":
        if not self.bottom_m < self.waist_m < self.top_m:
            msg = "a nose loft needs its bottom under its waist under its top"
            raise ValueError(msg)
        return self


class NoseCheeks(Strict):
    """Lobes of the lower nose either side of a recessed coupler opening: between two heights the
    lid reaches forward by reach_m over the lateral band inner to outer and draws the middle back
    by recess_m."""

    bottom_m: Annotated[float, Field(ge=0, lt=5)]
    top_m: Level
    inner: Fraction
    outer: Fraction
    reach_m: Annotated[float, Field(ge=0, le=1)]
    recess_m: Annotated[float, Field(ge=0, le=1)]

    @model_validator(mode="after")
    def _ordered(self) -> "NoseCheeks":
        if not (self.bottom_m < self.top_m and self.inner < self.outer):
            msg = "nose cheeks need their bottom under their top and their inner edge inside"
            raise ValueError(msg)
        return self


DecalSlot = Literal[
    "light", "mask", "window", "stripe", "accent", "equipment", "doors", "lower_body", "skirt",
    "upper_body", "display", "housing", "glass",
]  # fmt: skip
"""Decal colours. ``tail`` is not one: the renderer lights that column red at the trailing end,
so it belongs to lamp lenses only (a lamp's ``tail`` share); red paint takes a body slot."""


class FrontDecal(Strict):
    """A pane on the front surface (lamp, grille, logo, dark field) between two heights and two
    lateral fractions; mirrored on both sides when inner is above 0, centred otherwise."""

    slot: DecalSlot
    bottom_m: Annotated[float, Field(ge=0, lt=5)]
    top_m: Level
    inner: Annotated[float, Field(ge=0, lt=1)]
    outer: Fraction
    round: Annotated[float, Field(ge=1.2, le=20)] = 6.0
    slant: Annotated[float, Field(ge=-0.5, le=0.5)] = 0.0
    under: bool = False
    tilt_deg: Annotated[float, Field(ge=-45, le=45)] = 0.0
    """Degrees the long axis is turned, the outer end rising."""
    tail: Annotated[float, Field(ge=0, le=1)] | None = None
    """A lamp's share given to a red tail lens; none leaves it to the forge's rule."""
    tail_side: Literal["outer", "inner", "below"] = "outer"
    tail_mode: Literal["separate", "combined"] = "separate"
    """``combined``: the lamp's white lens itself shows red at the trailing end (one LED or bulb
    cluster for both), so no separate red lens is drawn."""
    fill: bool = False
    """The lenses fill the lamp housing as one cluster."""
    lens_margin_m: Annotated[float, Field(ge=0, le=0.1)] | None = None
    """Metres between a cluster lamp's housing and its lenses; 0 fills it edge to edge."""
    logo: bool = False
    """The DB logo plate: the slot paints border and letters, field and counters are red."""
    logo_red_letters: bool = False
    """The logo on a light body: red border and letters, the slot paints field and counters."""
    seam: bool = False
    """A panel joint (a coupler cover outline): drawn just off the skin, under every other pane."""
    clear_lens: Literal["inner", "outer"] | None = None
    """That lens of a lamp's pair is a clear unlit lens; the other one is the lit lamp."""

    @model_validator(mode="after")
    def _ordered(self) -> "FrontDecal":
        if not (self.bottom_m < self.top_m and self.inner < self.outer):
            msg = "a front decal needs its bottom under its top and its inner edge inside its outer"
            raise ValueError(msg)
        if self.tail_mode == "combined" and (self.slot != "light" or self.tail):
            msg = "a combined tail lamp is a light decal without a separate red share"
            raise ValueError(msg)
        if self.logo_red_letters and not self.logo:
            msg = "red letters belong to a logo decal"
            raise ValueError(msg)
        return self


class FrontLettering(Strict):
    """Operator lettering on both sides of a cab end (the grey ICE logotype), read from outside: a
    word between two setbacks from the tip (on the nose or the cab side behind it) and two heights,
    its letters leaning by ``italic`` (shift of the top per unit of height); ``stripe_gap_m`` leaves
    the measured side stripe out behind it."""

    text: Annotated[str, Field(pattern=r"^[CEI]+$")]
    """Letters the forge has glyphs for."""
    from_m: Setback
    to_m: Setback
    bottom_m: Level
    top_m: Level
    italic: Annotated[float, Field(ge=0, le=0.5)] = 0.0
    stripe_gap_m: tuple[Setback, Setback] | None = None

    @model_validator(mode="after")
    def _ordered(self) -> "FrontLettering":
        gap = self.stripe_gap_m
        if not (self.from_m < self.to_m and self.bottom_m < self.top_m) or (
            gap is not None and gap[0] >= gap[1]
        ):
            msg = "lettering and its stripe gap need their start set back less than their end"
            raise ValueError(msg)
        return self


class Front(Strict):
    """A cab front measured from a licensed side or front view (heights above top of rail,
    setbacks backwards from the tip). Values listed in ``estimated`` are our stylisation."""

    source: Slug
    view_source: Slug | None = None
    length_m: NoseLength
    tip_height_m: Level
    face_top_m: Level | None = None
    bottom_m: Level | None = None
    bottom_setback_m: Setback
    screen_bottom_m: Level
    screen_top_m: Level
    screen_bottom_setback_m: Setback
    screen_top_setback_m: Setback
    screen_width: Fraction
    plan: Literal["pointed", "round", "flat"]
    plan_exponents: (
        tuple[Annotated[float, Field(ge=1.2, le=8)], Annotated[float, Field(ge=1, le=4)]] | None
    ) = None
    straight_m: Setback = 0.0
    mask_bottom_m: Level | None = None
    mask_top_m: Level | None = None
    mask_width: Fraction | None = None
    lamp_bottom_m: Level | None = None
    lamp_top_m: Level | None = None
    lamp_inner: Fraction | None = None
    lamp_outer: Fraction | None = None
    skirt_top_m: Level | None = None
    front_skirt_top_m: Level | None = None
    stripe: Literal["across", "sides", "dive", "none"] = "sides"
    stripe_bottom_m: Level | None = None
    stripe_top_m: Level | None = None
    front_stripe_bottom_m: Level | None = None
    front_stripe_top_m: Level | None = None
    cab_window: bool = False
    side_window_from_m: Setback | None = None
    side_window_to_m: Setback | None = None
    cab_length_m: NoseLength | None = None
    loft: NoseLoft | None = None
    face_bulge_m: Annotated[float, Field(ge=0, le=0.5)] = 0.0
    screen_widths: list[tuple[Level, Fraction]] | None = None
    side_profile: list[tuple[Setback, Level]] | None = None
    profile_by_height: list[tuple[Level, Setback]] | None = None
    plan_widths: list[tuple[Setback, Fraction]] | None = None
    tip_gap_m: Annotated[float, Field(ge=0, le=0.6)] | None = None
    stripe_curve: list[tuple[Setback, Level, Level]] | None = None
    chin_bottom_m: Annotated[float, Field(ge=0, lt=5)] | None = None
    chin_top_m: Level | None = None
    chin_width: Fraction | None = None
    cheeks: NoseCheeks | None = None
    band_curve: list[tuple[Annotated[float, Field(ge=0, lt=30)], Level, Level]] | None = None
    cab_glass_curve: list[tuple[Annotated[float, Field(ge=0, lt=30)], Level, Level]] | None = None
    """The cab side window's glass over the front of the band, [setback, bottom, top] points."""
    band_from_curve_start: bool = False
    """The band starts at its curve's first setback instead of beside the windscreen (ICE T)."""
    screen_round: Annotated[float, Field(ge=1.2, le=20)] | None = None
    screen_columns: bool = False
    """The pane windscreen is laid out in columns following its outline (a screen over a dome)."""
    screen_tone: Literal["dark", "light"] = "dark"
    """Light draws the windscreen grey-blue with a lighter upper part instead of near black."""
    mask_slot: Literal["mask", "equipment"] = "mask"
    buffers: bool = False
    decals: list[FrontDecal] | None = None
    lettering: FrontLettering | None = None
    plain_cab_side: bool = False
    """The cab side behind the nose keeps the body colour between sill and window top up to the
    cab's rear end (cab_length_m), where the passenger windows and their dark band start."""
    side_window_bottom_m: Level | None = None
    side_window_top_m: Level | None = None
    side_window_round_m: Annotated[float, Field(ge=0, le=1.5)] = 0.0
    side_window_rake: Annotated[float, Field(ge=0, le=3)] | None = None
    estimated: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistent(self) -> "Front":
        not_measures = {"source", "view_source", "estimated"}
        unknown = set(self.estimated) - (set(type(self).model_fields) - not_measures)
        if unknown:
            msg = f"front estimated names unknown fields: {sorted(unknown)}"
            raise ValueError(msg)
        if self.screen_bottom_m >= self.screen_top_m or self.screen_bottom_m < self.tip_height_m:
            msg = "front windscreen must lie above the tip with its bottom under its top"
            raise ValueError(msg)
        setbacks = (self.bottom_setback_m, self.screen_bottom_setback_m, self.screen_top_setback_m)
        if any(s > self.length_m for s in (*setbacks, self.straight_m)):
            msg = "a front part is set back further than the front is long"
            raise ValueError(msg)
        if self.screen_bottom_setback_m > self.screen_top_setback_m:
            msg = "the windscreen top must be set back at least as far as its bottom"
            raise ValueError(msg)
        if (self.mask_bottom_m is None) != (self.mask_width is None):
            msg = "a front mask needs its bottom and its width"
            raise ValueError(msg)
        if (self.stripe_bottom_m is None) != (self.stripe_top_m is None):
            msg = "a front stripe needs its bottom and its top"
            raise ValueError(msg)
        if self.stripe == "dive" and self.front_stripe_bottom_m is None:
            msg = "a stripe that dives to the front needs the band it reaches across the front"
            raise ValueError(msg)
        if (self.front_stripe_bottom_m is None) != (self.front_stripe_top_m is None):
            msg = "a front stripe across the middle needs its bottom and its top"
            raise ValueError(msg)
        if self.bottom_m is not None and self.bottom_m >= self.tip_height_m:
            msg = "the bottom of a front must lie below the tip"
            raise ValueError(msg)
        if self.cab_length_m is not None and self.cab_length_m < self.length_m:
            msg = "the cab is shorter than the front"
            raise ValueError(msg)
        self._check_side_window()
        self._check_profile_by_height()
        lamps = (self.lamp_bottom_m, self.lamp_top_m, self.lamp_inner, self.lamp_outer)
        if any(v is not None for v in lamps) and not all(v is not None for v in lamps):
            msg = "front lamps need bottom, top, inner and outer"
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def _measured_shape(self) -> "Front":
        if self.side_profile is not None and self.profile_by_height is not None:
            msg = "a front takes a side profile or a profile by height, not both"
            raise ValueError(msg)
        if self.side_profile is not None:
            heights = [z for _, z in self.side_profile]
            if len(self.side_profile) < 2 or len(set(heights)) != len(heights):
                msg = "a measured side profile needs at least two points at different heights"
                raise ValueError(msg)
            if min(s for s, _ in self.side_profile) != 0 or any(
                s > self.length_m for s, _ in self.side_profile
            ):
                msg = "a measured side profile starts at the tip and ends within the front"
                raise ValueError(msg)
        if self.plan_widths is not None:
            setbacks = [s for s, _ in self.plan_widths]
            fractions = [f for _, f in self.plan_widths]
            rising = all(b > a for a, b in itertools.pairwise(setbacks)) and all(
                b > a for a, b in itertools.pairwise(fractions)
            )
            if len(self.plan_widths) < 2 or not rising or fractions[-1] != 1:
                msg = "a measured plan widens with every point to the full width"
                raise ValueError(msg)
            if setbacks[-1] > self.length_m:
                msg = "a measured plan is longer than the front"
                raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def _lettering_gap_on_the_stripe_curve(self) -> "Front":
        lettering = self.lettering
        if lettering is None or lettering.stripe_gap_m is None:
            return self
        gap = lettering.stripe_gap_m
        curve = self.stripe_curve
        on_curve = curve is not None and gap[1] <= max(s for s, _, _ in curve)
        on_side = curve is None and self.stripe == "sides" and gap[0] >= self.length_m
        if not (on_curve or on_side):
            msg = (
                "a stripe gap behind lettering lies on the measured stripe curve or on the side"
                " stripe behind the nose"
            )
            raise ValueError(msg)
        return self

    def _check_profile_by_height(self) -> None:
        points = self.profile_by_height
        if points is None:
            return
        heights = [z for z, _ in points]
        if len(points) < 3 or any(b <= a for a, b in itertools.pairwise(heights)):
            msg = "a profile by height needs at least three points with rising heights"
            raise ValueError(msg)
        if any(s > self.length_m for _, s in points):
            msg = "a profile by height point is set back further than the front is long"
            raise ValueError(msg)

    def _check_side_window(self) -> None:
        bounds = (self.side_window_from_m, self.side_window_to_m)
        if bounds == (None, None):
            return
        start, end = bounds
        if start is None or end is None or start >= end or not self.cab_window:
            msg = "a side window needs cab_window and its start set back less than its end"
            raise ValueError(msg)
        heights = (self.side_window_bottom_m, self.side_window_top_m)
        if (heights[0] is None) != (heights[1] is None) or (
            heights[0] is not None and heights[1] is not None and heights[0] >= heights[1]
        ):
            msg = "a cab side window band needs its bottom under its top"
            raise ValueError(msg)

    def levels(self) -> tuple[float, ...]:
        found = (
            self.screen_top_m, self.face_top_m, self.mask_bottom_m, self.mask_top_m,
            self.lamp_top_m, self.stripe_top_m, self.front_stripe_top_m,
        )  # fmt: skip
        return tuple(v for v in found if v is not None)


class CarType(Sourced):
    car_type: Slug
    name: Text
    role: CarRole
    length_m: Length | None = None
    width_m: Width | None = None
    height_m: Height | None = None
    floor_height_m: Level | None = None
    double_deck: bool
    lower_deck_floor_m: Level | None = None
    bogies: list[BogieKind] = Field(min_length=2, max_length=2)
    bogie_pitch_m: Pitch | None = None
    bogie_offset_m: Offset | None = None
    bogie_wheelbase_m: Wheelbase | None = None
    jacobs_wheelbase_m: Wheelbase | None = None
    wheel_diameter_m: Wheel | None = None
    nose_shape: NoseShape | None = None
    nose_length_m: NoseLength | None = None
    front: Front | None = None
    doors_per_side: Annotated[int, Field(ge=0, le=8)] | None = None
    door_positions_m: list[float] | None = None
    door_width_m: DoorWidth | None = None
    window_sill_m: Level | None = None
    window_top_m: Level | None = None
    window_width_m: Annotated[float, Field(gt=0.3, lt=4)] | None = None
    window_pillar_m: Annotated[float, Field(gt=0.02, lt=2)] | None = None
    tumblehome_m: Annotated[float, Field(ge=0, le=0.3)] | None = None
    body_bottom_m: Annotated[float, Field(gt=0.2, lt=1.5)] | None = None
    bogie_skirt_m: Annotated[float, Field(gt=0.5, lt=1.5)] | None = None
    """Bottom of the side skirt over the bogies (the forge raises the side there otherwise)."""
    roof_exponent: Annotated[float, Field(ge=1.5, le=8)] | None = None
    window_pillars: Literal["band", "body", "mask"] | None = None
    pantograph_count: Annotated[int, Field(ge=0, le=4)] | None = None
    pantograph_positions_m: list[float] | None = None
    roof_equipment_m: list[tuple[float, float]] | None = None
    side_panels_m: list[tuple[float, float, float, float]] | None = None
    missing: dict[str, Text] = Field(default_factory=dict)

    def explained_fields(self) -> tuple[str, ...]:
        fields = list(ALWAYS_EXPLAINED)
        if BogieKind.OWN in self.bogies:
            fields += ["bogie_pitch_m", "bogie_wheelbase_m"]
        if BogieKind.JACOBS in self.bogies:
            fields.append("jacobs_wheelbase_m")
        if self.doors_per_side != 0:
            fields.append("door_width_m")
        if self.bogies == [BogieKind.OWN, BogieKind.OWN] and self.role in NOSE_ROLES:
            fields.append("bogie_offset_m")
        if self.role in NOSE_ROLES:
            fields += ["nose_shape", "front"]
            if self.front is None:
                fields.append("nose_length_m")
        if self.double_deck:
            fields.append("lower_deck_floor_m")
        if self.pantograph_count:
            fields.append("pantograph_positions_m")
        return tuple(fields)

    @model_validator(mode="after")
    def _complete_and_consistent(self) -> "CarType":
        name = self.car_type
        for field in self.explained_fields():
            empty = getattr(self, field) is None
            if empty and field not in self.missing:
                msg = f"{name}: {field} is empty without a reason in missing"
                raise ValueError(msg)
            if not empty and field in self.missing:
                msg = f"{name}: {field} has a value and a reason in missing"
                raise ValueError(msg)
        if self.role not in NOSE_ROLES and (self.nose_shape or self.nose_length_m or self.front):
            msg = f"{name}: a {self.role} car has nose fields"
            raise ValueError(msg)
        if self.front is not None and self.nose_length_m is not None:
            msg = f"{name}: give nose_length_m and front not both, the front has its length"
            raise ValueError(msg)
        if self.bogies == [BogieKind.JACOBS, BogieKind.JACOBS] and self.bogie_pitch_m is not None:
            msg = f"{name}: the pitch of a car on two Jacobs bogies is its length, leave it empty"
            raise ValueError(msg)
        self._check_lengths(name)
        self._check_heights(name)
        return self

    def _check_lengths(self, name: str) -> None:
        if self.length_m is None:
            return
        half = self.length_m / 2
        if self.bogie_pitch_m is not None and self.bogie_pitch_m >= self.length_m:
            msg = f"{name}: bogie pitch longer than the car"
            raise ValueError(msg)
        doors = self.door_positions_m
        if doors is not None:
            if self.doors_per_side is not None and len(doors) != self.doors_per_side:
                msg = f"{name}: {len(doors)} door positions for {self.doors_per_side} doors"
                raise ValueError(msg)
            if any(abs(x) >= half for x in doors):
                msg = f"{name}: a door lies outside the car"
                raise ValueError(msg)
        positions = self.pantograph_positions_m
        if positions is not None and len(positions) != (self.pantograph_count or 0):
            count = self.pantograph_count
            msg = f"{name}: {len(positions)} pantograph positions for {count} pantographs"
            raise ValueError(msg)
        if positions and any(abs(x) >= half for x in positions):
            msg = f"{name}: a pantograph lies outside the car"
            raise ValueError(msg)
        for start, end in self.roof_equipment_m or []:
            if not -half < start < end < half:
                msg = f"{name}: roof equipment must run forwards inside the car"
                raise ValueError(msg)
        roof = self.height_m if self.height_m is not None else float("inf")
        for start, end, bottom, top in self.side_panels_m or []:
            if not -half < start < end < half or not 0 < bottom < top < roof:
                msg = f"{name}: a side panel must run forwards inside the car, below the roof"
                raise ValueError(msg)

    def _check_heights(self, name: str) -> None:
        roof = self.height_m
        if self.front is not None and roof is not None and max(self.front.levels()) >= roof:
            msg = f"{name}: the front reaches above the roof"
            raise ValueError(msg)
        if roof is not None and self.floor_height_m is not None and self.floor_height_m >= roof:
            msg = f"{name}: floor above the roof"
            raise ValueError(msg)
        skirt, wheel = self.bogie_skirt_m, self.wheel_diameter_m
        if skirt is not None and wheel is not None and skirt <= wheel + 0.06:
            msg = f"{name}: the bogie skirt must clear the wheels"
            raise ValueError(msg)
        sill, top = self.window_sill_m, self.window_top_m
        below_roof = roof is None or top is None or top < roof
        if sill is not None and top is not None and (sill >= top or not below_roof):
            msg = f"{name}: window band must lie below the roof with its sill under its top"
            raise ValueError(msg)

    def referenced_sources(self) -> set[str]:
        found = super().referenced_sources()
        if self.front is None:
            return found
        return found | {self.front.source} | ({self.front.view_source} - {None})

    def bogie_kinds(self, reversed_: bool) -> tuple[BogieKind, BogieKind]:
        front, rear = self.bogies
        return (rear, front) if reversed_ else (front, rear)


class FormationCar(Strict):
    car_type: Slug
    reversed: bool = False


class VehicleModel(Sourced):
    model_id: Slug
    name: Text
    series_id: Slug | None = None
    generic: bool
    category: Annotated[str, Field(pattern=r"^[a-z]{2,16}$")]
    livery_id: Slug | None = None
    unit_length_m: Annotated[float, Field(gt=5, lt=500)] | None = None
    length_gap_reason: Text | None = None
    formation: list[FormationCar] = Field(min_length=1)
    car_types: list[CarType] = Field(min_length=1)
    missing: dict[str, Text] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _consistent(self) -> "VehicleModel":
        name = self.model_id
        if self.generic and self.series_id:
            msg = f"{name}: a generic model names a series"
            raise ValueError(msg)
        if not self.generic and not self.series_id:
            msg = f"{name}: a series model needs a series_id"
            raise ValueError(msg)
        for field in ("livery_id", "unit_length_m"):
            empty = getattr(self, field) is None
            if empty and field not in self.missing:
                msg = f"{name}: {field} is empty without a reason in missing"
                raise ValueError(msg)
            if not empty and field in self.missing:
                msg = f"{name}: {field} has a value and a reason in missing"
                raise ValueError(msg)
        types = {c.car_type: c for c in self.car_types}
        if len(types) != len(self.car_types):
            msg = f"{name}: car types must be unique"
            raise ValueError(msg)
        for slot in self.formation:
            if slot.car_type not in types:
                msg = f"{name}: unknown car type {slot.car_type!r} in the formation"
                raise ValueError(msg)
        unused = sorted(set(types) - {slot.car_type for slot in self.formation})
        if unused:
            msg = f"{name}: car types never used in the formation: {unused}"
            raise ValueError(msg)
        self._check_jacobs(types)
        self._check_unit_length(types)
        return self

    def _check_jacobs(self, types: dict[str, CarType]) -> None:
        kinds = [types[s.car_type].bogie_kinds(s.reversed) for s in self.formation]
        wheelbases = [types[s.car_type].jacobs_wheelbase_m for s in self.formation]
        for index, (ahead, behind) in enumerate(itertools.pairwise(kinds), start=1):
            pair = f"cars {index} and {index + 1}"
            if (ahead[1] is BogieKind.JACOBS) != (behind[0] is BogieKind.JACOBS):
                msg = f"{self.model_id}: Jacobs bogie between {pair} not shared"
                raise ValueError(msg)
            first, second = wheelbases[index - 1], wheelbases[index]
            if ahead[1] is BogieKind.JACOBS and first and second and first != second:
                msg = f"{self.model_id}: Jacobs bogie between {pair}: {first} m and {second} m"
                raise ValueError(msg)
        if BogieKind.JACOBS in (kinds[0][0], kinds[-1][1]):
            msg = f"{self.model_id}: the unit ends on a Jacobs bogie"
            raise ValueError(msg)

    def _check_unit_length(self, types: dict[str, CarType]) -> None:
        lengths = [types[s.car_type].length_m for s in self.formation]
        if self.unit_length_m is None or any(x is None for x in lengths):
            if self.length_gap_reason:
                msg = f"{self.model_id}: no gap to explain without the unit and car lengths"
                raise ValueError(msg)
            return
        total = sum(x for x in lengths if x is not None)
        gap = abs(total - self.unit_length_m) > UNIT_LENGTH_TOLERANCE_M
        if gap and not self.length_gap_reason:
            msg = (
                f"{self.model_id}: the cars add up to {total:.2f} m, the unit is"
                f" {self.unit_length_m:.2f} m, without a length_gap_reason"
            )
            raise ValueError(msg)
        if not gap and self.length_gap_reason:
            msg = f"{self.model_id}: no gap to explain, the cars add up to {total:.2f} m"
            raise ValueError(msg)

    def referenced_sources(self) -> set[str]:
        found = super().referenced_sources()
        for car in self.car_types:
            found |= car.referenced_sources()
        return found
