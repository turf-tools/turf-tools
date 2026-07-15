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

from pydantic import BaseModel

if TYPE_CHECKING:
    import duckdb
    from src.models import TableRef

# The fixed filter-kind vocabulary. This is the "stays code" set — adding an
# entry here touches the editor + both compilers, so it's deliberately
# comprehensive. Excludes the system filters (`all`, `canvass-outcome`,
# `canvass-response`, `segment`): those read canvass_events / other segments,
# not the person row, so they're always present and live outside the manifest.
FilterKind = Literal[
    "text",  # equals / contains — names, emails
    "enum",  # multi-select over a scalar column; curated or data-derived values
    "code-multi",  # type-a-list of codes; scalar IN over open-valued codes
    "number",  # numeric range; also the target of the birthdate→age role
    "date",  # date range
    "tags",  # array-contains-any over a list column; the generic cousin of voting-history
    "voting-history",  # structured list: membership + count-in-window + presets
    "address",  # the geocodable composite (canonical; also filters)
]

# Semantic affordances layered on a field beyond its raw type. `birthdate` marks
# a date column that also offers an age (number) filter, sourced via
# datediff(year, dob, today). Kept open for future roles.
FieldRole = Literal["birthdate"]


class EnumValue(BaseModel):
    """One choice for an `enum` / `code-multi` / `tags` field. `label` is the
    display text; absent → show the raw `value`. Curated by a known-format
    importer, or auto-derived from the data (+ optional relabel) for generic
    imports."""

    value: str
    label: str | None = None


class FieldDef(BaseModel):
    """One filterable field. Mirrors the old `FilterDef`/`FieldDef` pair — the
    union of what the web editor and the SQL compiler each need — now data.
    """

    # Every field is a top-level `persons_geocoded` column (shredded for Parquet
    # pruning + Bloom filters). `column` doubles as the filter `key`.
    column: str
    label: str  # editor display label
    filter_kind: FilterKind
    # `text` only — names use `contains`, codes/zips use `equals`.
    op: Literal["equals", "contains"] | None = None
    # `enum` / `code-multi` / `tags` value catalog. None → no fixed catalog
    # (freetext code entry, or values not yet derived).
    values: list[EnumValue] | None = None
    # Affordance role (e.g. birthdate→age). None for plain fields.
    role: FieldRole | None = None
    # Marks this field as a zone boundary key for the named key group (replaces
    # the old `KEY_GROUPS` map). The zone editor offers a key group only when a
    # dataset has a field carrying it. `zip5` always carries one; others are
    # present only if the source provides the column.
    key_group: str | None = None


class Manifest(BaseModel):
    """The per-version filterable-field catalog. Consumed by the web editor and
    the SQL compiler; resolved *per queried version* (a live segment reads the
    active version's manifest, a published turf its pinned version's).

    Only filterable fields live here. The required canonical fields the app
    can't run without — `external_id`, name, geocodable address, coords — are
    the importer's transform concern (baked for known formats, user-mapped for
    generic); a canonical one that also filters (name → text, address → the
    `address` kind) appears here too, but `external_id`/coords don't.
    """

    fields: list[FieldDef]


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

    def manifest(self) -> Manifest: ...

    def load(
        self,
        source: str,
        schema: str,
        conn: duckdb.DuckDBPyConnection,
    ) -> TableRef: ...
