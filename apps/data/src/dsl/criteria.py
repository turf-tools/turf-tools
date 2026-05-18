"""Pydantic models for the criteria DSL + the field/key-group catalog.

Mirror of `apps/web/src/lib/filters.ts` (filter shapes + FILTERS catalog)
and `apps/web/src/lib/key-groups.ts` (KEY_GROUPS catalog). The TS side
keeps these for the editor UI; data side keeps them for SQL compilation.

Adding a new filter kind / catalog entry requires updating both sides —
the duplication is types-only (compiler logic lives in one language;
see `compile.py`).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Filter instances — what flows in the request body.
# ---------------------------------------------------------------------------


class AllFilter(BaseModel):
    """Matches every person. Useful as the target of a "remove" step to
    reset the running set to empty, enabling a build-from-nothing flow.
    Compiles to ``1=1``."""

    kind: Literal["all"]


class EnumFilter(BaseModel):
    kind: Literal["enum"]
    key: str
    values: list[str]


class AgeRangeFilter(BaseModel):
    kind: Literal["age-range"]
    key: str
    min: int | None = None
    max: int | None = None


class TextFilter(BaseModel):
    kind: Literal["text"]
    key: str
    value: str


class DateRangeFilter(BaseModel):
    """ISO-8601 (YYYY-MM-DD) range. Either bound is optional."""

    kind: Literal["date-range"]
    key: str
    min: str | None = None
    max: str | None = None


class VotingHistoryFilter(BaseModel):
    """Count of recent elections matching a type within a year window.

    ``primary`` covers both `primary` and `presidential_primary` canonical
    types — the common meaning of "primary" when targeting voters.
    """

    kind: Literal["voting-history-count"]
    key: str
    type: Literal["primary", "general"]  # noqa: A003
    windowYears: int  # noqa: N815  -- camelCase matches the JSON shape sent from web
    comparator: Literal["at_least", "exactly"]
    count: int


class AddressFilter(BaseModel):
    """Single UI element, multiple columns. Compiles to AND-joined clauses
    for whichever sub-fields are non-empty."""

    kind: Literal["address"]
    key: Literal["address"]
    line1: str
    city: str
    state: str
    zip: str  # noqa: A003


class NestedFilter(BaseModel):
    """Wraps a complete sub-criteria as a single filter. Produced by the
    web layer when expanding segment references; the data server never
    sees segment ids — only resolved nested criteria. Compiles to a
    parenthesised boolean expression that the outer step's verb composes
    in the usual way."""

    kind: Literal["nested"]
    criteria: "Criteria"


Filter = Annotated[
    AllFilter
    | EnumFilter
    | AgeRangeFilter
    | TextFilter
    | DateRangeFilter
    | VotingHistoryFilter
    | AddressFilter
    | NestedFilter,
    Field(discriminator="kind"),
]


class KeyFilter(BaseModel):
    """Spatial scope — clip results to persons whose boundary key falls in
    the supplied set. Used by the campaign editor to constrain segment
    queries to a zone group's zones (segment ∩ zone group).
    """

    keyGroup: str  # noqa: N815  -- camelCase matches the JSON shape sent from web
    keys: list[str]


# ---------------------------------------------------------------------------
# Criteria — ordered sequence of steps with verbs.
# ---------------------------------------------------------------------------

Verb = Literal["add", "narrow", "remove"]


class Step(BaseModel):
    verb: Verb
    filter: Filter  # noqa: A003


class Criteria(BaseModel):
    steps: list[Step] = []


# NestedFilter forward-references Criteria; resolve once both exist.
NestedFilter.model_rebuild()


# ---------------------------------------------------------------------------
# Field catalog — schema metadata used by the SQL compiler.
# ---------------------------------------------------------------------------


class EnumFieldDef(BaseModel):
    kind: Literal["enum"]
    key: str
    source: Literal["column", "other_properties"]


class AgeRangeFieldDef(BaseModel):
    kind: Literal["age-range"]
    key: str
    source: Literal["column", "other_properties"]


class TextFieldDef(BaseModel):
    kind: Literal["text"]
    key: str
    source: Literal["column", "other_properties"]
    op: Literal["equals", "contains"]


class DateRangeFieldDef(BaseModel):
    kind: Literal["date-range"]
    key: str
    source: Literal["column", "other_properties"]


class VotingHistoryFieldDef(BaseModel):
    kind: Literal["voting-history-count"]
    key: str  # the STRUCT[] column name, e.g. "voting_history"
    source: Literal["column"]  # always a top-level STRUCT[]; no JSON path here


class AddressFieldDef(BaseModel):
    kind: Literal["address"]
    key: Literal["address"]


FieldDef = EnumFieldDef | AgeRangeFieldDef | TextFieldDef | DateRangeFieldDef | VotingHistoryFieldDef | AddressFieldDef


# Catalog of filterable fields. `source` says whether the field is a
# top-level column on `persons_geocoded` or a JSONB key inside
# `other_properties`. `op` on text fields is fixed per-field — names use
# `contains`, codes/zips use `equals`. If a field needs both, add it
# twice with different keys.
#
# Keep in sync with FILTERS in `apps/web/src/lib/filters.ts`.
FIELDS: dict[str, FieldDef] = {
    # All filterable voter-file fields are top-level columns on `persons_geocoded`.
    # Storage is shredded for filter perf (Parquet column pruning + Bloom filters).
    # Listed alphabetically by key.
    "assembly_district": TextFieldDef(kind="text", key="assembly_district", source="column", op="equals"),
    "congressional_district": TextFieldDef(kind="text", key="congressional_district", source="column", op="equals"),
    "date_of_birth": AgeRangeFieldDef(kind="age-range", key="date_of_birth", source="column"),
    "enrollment": EnumFieldDef(kind="enum", key="enrollment", source="column"),
    "address": AddressFieldDef(kind="address", key="address"),
    "county_code": EnumFieldDef(kind="enum", key="county_code", source="column"),
    "first_name": TextFieldDef(kind="text", key="first_name", source="column", op="contains"),
    "gender": EnumFieldDef(kind="enum", key="gender", source="column"),
    "last_name": TextFieldDef(kind="text", key="last_name", source="column", op="contains"),
    "precinct": TextFieldDef(kind="text", key="precinct", source="column", op="equals"),
    "registration_date": DateRangeFieldDef(kind="date-range", key="registration_date", source="column"),
    "registration_status": EnumFieldDef(kind="enum", key="registration_status", source="column"),
    "senate_district": TextFieldDef(kind="text", key="senate_district", source="column", op="equals"),
    "voting_history": VotingHistoryFieldDef(kind="voting-history-count", key="voting_history", source="column"),
    # `zip5` isn't exposed as a standalone filter (subsumed by `address`)
    # but is still queried directly by `nyc_zips` boundary-key resolution.
    "zip5": TextFieldDef(kind="text", key="zip5", source="column", op="equals"),
}


# ---------------------------------------------------------------------------
# Key group catalog — boundary keyGroup → field that carries the key on
# persons_geocoded. Mirror of `apps/web/src/lib/key-groups.ts`.
# ---------------------------------------------------------------------------


# Maps a boundary keyGroup name (used in zone groups + boundary tables)
# to the field key on persons_geocoded that carries each person's
# region key. Used to compose `keyFilter` clauses and per-key
# aggregation GROUP BYs.
KEY_GROUPS: dict[str, str] = {
    "nyc_eds": "precinct",
    "nyc_zips": "zip5",
}
