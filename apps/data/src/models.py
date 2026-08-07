"""Shared data models for Hamilton graph nodes."""

import re
from dataclasses import dataclass

from pydantic import BaseModel

# A SQL identifier is "safe" to leave unquoted if it starts with a letter
# or underscore and is followed only by lowercase letters, digits, or
# underscores. Anything else (hyphens, uppercase, leading digits,
# spaces, …) must be quoted. We don't try to detect reserved words —
# the small noise cost when a slug happens to be one is worth not
# maintaining a keyword list.
_SAFE_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def quote_ident(name: str) -> str:
    """Return `name` as a SQL identifier, quoted only when necessary.

    Embedded double quotes are escaped by doubling. Used by `TableRef.fqn`
    and `tables.table_fqn` to keep generated SQL readable when
    slugs are plain (`default`, `acme`) and still safe when they aren't
    (`test-org`).
    """
    if _SAFE_IDENT_RE.match(name):
        return name
    return '"' + name.replace('"', '""') + '"'


@dataclass(frozen=True)
class TableRef:
    """Reference to a table in DuckLake.

    Returned by Hamilton nodes instead of actual data. Downstream nodes
    use the reference to locate the table in DuckLake.
    """

    catalog: str
    schema: str
    table: str
    version: int

    @property
    def fqn(self) -> str:
        """Fully qualified table name: catalog.schema.table.

        Schema is quoted only when it contains characters that aren't
        valid in a bare SQL identifier (so a plain `default` stays
        unquoted but `test-org` becomes `"test-org"`).
        """
        return f"{self.catalog}.{quote_ident(self.schema)}.{self.table}"


@dataclass(frozen=True)
class QuickwitIngestResult:
    """Summary of one Quickwit local-ingest build run."""

    index_id: str
    source_table_fqn: str
    source_table_version: int
    indexed_doc_count: int
    batch_count: int
    elapsed_seconds: float


@dataclass(frozen=True)
class QuickwitBuildManifestStub:
    """Placeholder payload for the future manifest writer."""

    index_id: str
    source_table_fqn: str
    source_table_version: int
    indexed_doc_count: int
    batch_count: int
    elapsed_seconds: float
    manifest_written: bool = False


class Person(BaseModel):
    """The core person record every importer's transform must produce — the
    columns the shared geocoding pipeline consumes by name: identity, name, and
    the geocodable address.

    This is the *required* contract, not the full column set. An importer's
    `persons_validated` also carries whatever additional, filterable fields its
    dataset has (enrollment, districts, voting history, …); those are described
    by the importer's `Manifest` and are not modeled here. `assembly` carries
    every such column into `persons_geocoded` generically, so adding a field
    needs no pipeline change — hence `_validate` checks these columns are
    *present* (a subset), not that they're the *only* columns. Extra fields are
    plain top-level columns (fast: Parquet pruning + Bloom filters); there is no
    catch-all JSON blob — the manifest is the performant equivalent.
    """

    external_id: str
    external_id_type: str

    first_name: str
    last_name: str
    middle_name: str | None = None
    # Jr/Sr/III — disambiguates same-name voters at one address for canvassers.
    name_suffix: str | None = None

    # Geocodable address — consumed by the matching/geocoding DAG nodes.
    address_line_1: str
    address_line_2: str | None = None
    half_code: str | None = None
    city: str
    state: str
    zip5: str
    zip4: str | None = None
