"""The importer contract + the field manifest model.

The `Manifest` is the per-dataset-version field catalog. It replaces the
hardcoded, web/data-duplicated catalogs — `apps/web/src/lib/filters.ts`
(`FILTER_SECTIONS`/`FilterDef`) and this package's former `dsl/criteria.py`
`FIELDS` + `KEY_GROUPS` — with one structure both sides consume: the web fetches
it to render the segment/zone editors, the data server reads it to compile SQL.

Scope principle: **fields become data, kinds stay code.** The *set* of filter
kinds (below) and their per-kind logic (how each renders an input / compiles to
SQL) stay hardcoded — parallel code in TS + Python, since they're the wire
contract + behaviour. Only the *field list* becomes per-version data. Adding a
field is free manifest data; adding a kind is the expensive cross-language change.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, Protocol

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

if TYPE_CHECKING:
    import duckdb
    from src.models import TableRef

# The fixed filter-kind vocabulary. This is the "stays code" set — adding an
# entry here touches the editor + both compilers. Kinds mirror the filter
# *instance* kinds 1:1 (see dsl/criteria.py), so mapping manifest → filter is
# near-identity. Excludes the system filters (`all`, `canvass-outcome`,
# `canvass-response`, `segment`): those read canvass_events / other segments,
# not the person row, so they're always present and live outside the manifest.
FilterKind = Literal[
    "text",  # substring match — names
    "enum",  # multi-select over a scalar column; curated or data-derived values
    "text-multi",  # type-a-list of codes; scalar IN over open-valued codes
    "age-range",  # numeric age range derived from a birthdate column
    "date-range",  # date range
    "voting-history-count",  # count of matching elections in a recency window
    "address",  # the geocodable composite (canonical; also filters)
]


class _CamelModel(BaseModel):
    """Manifest models serialize camelCase to match the rest of the jsonb wire
    (turf_data, segments.criteria) and give the web idiomatic field names.
    Python attribute access stays snake_case; only the JSON keys are camel."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class EnumValue(_CamelModel):
    """One choice for an `enum` / `text-multi` field. `label` is the display
    text; absent → show the raw `value`. Curated by a known-format importer, or
    auto-derived from the data (+ optional relabel) for generic imports."""

    value: str
    label: str | None = None


class FieldDef(_CamelModel):
    """One filterable field — the union of what the web editor and the SQL
    compiler each need, as data."""

    # Every field is a top-level `persons_geocoded` column (shredded for Parquet
    # pruning + Bloom filters). `column` doubles as the filter `key`.
    column: str
    label: str  # editor display label
    filter_kind: FilterKind
    # `enum` / `text-multi` value catalog. None → no fixed catalog (freetext
    # code entry, or values not yet derived).
    values: list[EnumValue] | None = None
    # Marks this field as a zone boundary key for the named key group (replaces
    # the old `KEY_GROUPS` map). The zone editor offers a key group only when a
    # dataset has a field carrying it. `zip5` always carries one; others are
    # present only if the source provides the column. Exactly one field carries a
    # given key group, so `key_group_label` (the group's display name in the zone
    # editor, e.g. "Election districts") rides alongside it. Compiler ignores both.
    key_group: str | None = None
    key_group_label: str | None = None


class Manifest(_CamelModel):
    """The per-version filterable-field catalog. Consumed by the web editor and
    the SQL compiler; resolved *per queried version* (a live segment reads the
    active version's manifest, a published turf its pinned version's).

    `fields` is a list of *sections* (each an inner list) — the grouping the
    editor renders with separators between groups; the structure is the grouping,
    so sections need no names. The SQL compiler flattens and ignores sections. The
    web wraps these with its dataset-independent system-filter sections (`all` on
    top; canvass + segment at the bottom).

    Only filterable fields live here. The required canonical fields the app
    can't run without — `external_id`, name, geocodable address, coords — are
    the importer's transform concern (baked for known formats, user-mapped for
    generic); a canonical one that also filters (name → text, address → the
    `address` kind) appears here too, but `external_id`/coords don't.
    """

    fields: list[list[FieldDef]]


class Progress(Protocol):
    """What `load` reports against — a step counter shared with the DAG. `advance`
    is called once per load stage; the job sizes the total from `PROGRESS_STEPS`
    plus the DAG's node count."""

    def advance(self, n: int = 1) -> None: ...


class Importer(Protocol):
    """Turns a source into `(persons_validated, manifest)`.

    `load` owns the full source→canonical path: an optional decode stage (a raw
    fixed-width state file → tabular columns), the transform to the `Person`
    schema, value canonicalization, and validation — returning the
    `persons_validated` TableRef the shared pipeline picks up from. `source` may
    be a raw distribution (decoded) or an already-tabular parquet/CSV (decode
    skipped).

    Convention: each importer is a package whose `importer.py` defines the
    concrete class, with supporting stages in sibling modules; the package
    `__init__` re-exports the class.
    """

    name: str
    # Number of times `load` calls `progress.advance()`, so the job can size the
    # progress total (these stages + the DAG's nodes) before running.
    PROGRESS_STEPS: int

    def manifest(self) -> Manifest: ...

    def load(
        self,
        source: str,
        schema: str,
        conn: duckdb.DuckDBPyConnection,
        progress: Progress,
    ) -> TableRef: ...
