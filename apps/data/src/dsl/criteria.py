"""Pydantic models for the criteria DSL + the compiler's field catalog.

The filter *shapes* (`EnumFilter`, `TextFilter`, …) mirror the wire contract in
`apps/web/src/lib/filters.ts` — the fixed vocabulary of filter kinds both sides
speak. Adding a *kind* touches both languages; that duplication is types-only
(compiler logic lives here, see `compile.py`).

The *field list*, by contrast, is no longer hardcoded: `build_field_catalog`
derives the compiler's `FieldCatalog` from a dataset version's `Manifest` (the
authority). The `*FieldDef` classes below are the compiler's internal typed form.
"""

from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from src.importers.base import Manifest

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


class TextMultiFilter(BaseModel):
    """OR-matches the column against any value in `values`. Compiles to
    SQL `IN (...)`. Single-value usage remains expressible as a
    one-element list."""

    kind: Literal["text-multi"]
    key: str
    values: list[str]


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

    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["voting-history-count"]
    key: str
    type: Literal["primary", "general"]  # noqa: A003
    window_years: int = Field(validation_alias="windowYears")
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


class CanvassOutcomeFilter(BaseModel):
    """Prior canvass dispositions read back from canvass_events. Matches a
    person if any of their per-turf current results has an outcome in
    `outcomes`. Resolved to a `PersonIdSetFilter` by `resolve_canvass_refs`
    before SQL compilation — the compiler never sees this kind."""

    kind: Literal["canvass-outcome"]
    outcomes: list[str]


class CanvassResponseFilter(BaseModel):
    """A prior canvass answer to a specific question. Matches a person if any
    of their per-turf current results answered `question_id` with one of
    `option_ids`. Resolved to a `PersonIdSetFilter` before SQL compilation —
    the compiler never sees this kind."""

    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["canvass-response"]
    question_id: str = Field(validation_alias="questionId")
    option_ids: list[str] = Field(validation_alias="optionIds")


class PersonIdSetFilter(BaseModel):
    """A literal set of person `external_id`s. Produced by resolving an
    operational-data filter (e.g. CanvassOutcomeFilter) down to the persons
    that match; compiles to ``external_id IN (...)``. Never persisted —
    only exists post-resolution, like NestedFilter."""

    kind: Literal["person-id-set"]
    ids: list[str]


class NestedFilter(BaseModel):
    """Wraps a complete sub-criteria as a single filter. Produced by
    `expand_segment_refs` when resolving segment references; the SQL
    compiler never sees a `SegmentFilter` — only `NestedFilter`. Compiles
    to a parenthesised boolean expression that the outer step's verb
    composes in the usual way."""

    kind: Literal["nested"]
    criteria: "Criteria"


class SegmentFilter(BaseModel):
    """Reference to another segment by id. Resolved to a `NestedFilter`
    by `expand_segment_refs` before SQL compilation."""

    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["segment"]
    segment_id: str | None = Field(default=None, validation_alias="segmentId")


Filter = Annotated[
    AllFilter
    | EnumFilter
    | AgeRangeFilter
    | TextFilter
    | TextMultiFilter
    | DateRangeFilter
    | VotingHistoryFilter
    | AddressFilter
    | CanvassOutcomeFilter
    | CanvassResponseFilter
    | PersonIdSetFilter
    | NestedFilter
    | SegmentFilter,
    Field(discriminator="kind"),
]


class KeyFilter(BaseModel):
    """Spatial scope — clip results to persons whose boundary key falls in
    the supplied set. Used by the campaign editor to constrain segment
    queries to a zone group's zones (segment ∩ zone group).
    """

    model_config = ConfigDict(populate_by_name=True)

    key_group: str = Field(validation_alias="keyGroup")
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


class AgeRangeFieldDef(BaseModel):
    kind: Literal["age-range"]
    key: str


class TextFieldDef(BaseModel):
    kind: Literal["text"]
    key: str


class TextMultiFieldDef(BaseModel):
    kind: Literal["text-multi"]
    key: str


class DateRangeFieldDef(BaseModel):
    kind: Literal["date-range"]
    key: str


class VotingHistoryFieldDef(BaseModel):
    kind: Literal["voting-history-count"]
    key: str  # the STRUCT[] column name, e.g. "voting_history"


class AddressFieldDef(BaseModel):
    kind: Literal["address"]
    key: Literal["address"]


FieldDef = (
    EnumFieldDef
    | AgeRangeFieldDef
    | TextFieldDef
    | TextMultiFieldDef
    | DateRangeFieldDef
    | VotingHistoryFieldDef
    | AddressFieldDef
)


# ---------------------------------------------------------------------------
# Field catalog — the compiler's per-version view of a dataset's fields, built
# from the `Manifest` (the authority). The `*FieldDef` classes above stay the
# compiler's internal typed form; `build_field_catalog` derives them from the
# manifest — the single field catalog `apps/web/src/lib/filters.ts` also reads.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FieldCatalog:
    """A resolved version's compilable fields.

    `fields` maps a filter `key` → the compiler's typed `FieldDef`. `key_groups`
    maps a boundary keyGroup → the field key carrying that key on
    persons_geocoded (drives `keyFilter` clauses + per-key aggregation GROUP BYs).
    """

    fields: dict[str, FieldDef]
    key_groups: dict[str, str]


def build_field_catalog(manifest: Manifest) -> FieldCatalog:
    """Derive the compiler catalog from a dataset version's `Manifest`.

    Manifest `filter_kind` values mirror the compiler's `FieldDef` kinds 1:1, so
    this is near-identity.
    """
    fields: dict[str, FieldDef] = {}
    key_groups: dict[str, str] = {}
    # Sections are a display concern; the compiler flattens them away.
    for fd in (fd for section in manifest.fields for fd in section):
        key = fd.column
        if fd.filter_kind == "text":
            fields[key] = TextFieldDef(kind="text", key=key)
        elif fd.filter_kind == "enum":
            fields[key] = EnumFieldDef(kind="enum", key=key)
        elif fd.filter_kind == "text-multi":
            fields[key] = TextMultiFieldDef(kind="text-multi", key=key)
        elif fd.filter_kind == "age-range":
            fields[key] = AgeRangeFieldDef(kind="age-range", key=key)
        elif fd.filter_kind == "date-range":
            fields[key] = DateRangeFieldDef(kind="date-range", key=key)
        elif fd.filter_kind == "voting-history-count":
            fields[key] = VotingHistoryFieldDef(kind="voting-history-count", key=key)
        elif fd.filter_kind == "address":
            fields[key] = AddressFieldDef(kind="address", key="address")
        if fd.key_group:
            key_groups[fd.key_group] = key
    return FieldCatalog(fields=fields, key_groups=key_groups)
