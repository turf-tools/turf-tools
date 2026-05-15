"""Shared data models for Hamilton graph nodes."""

import json
import re
from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, BeforeValidator

# A SQL identifier is "safe" to leave unquoted if it starts with a letter
# or underscore and is followed only by lowercase letters, digits, or
# underscores. Anything else (hyphens, uppercase, leading digits,
# spaces, …) must be quoted. We don't try to detect reserved words —
# the small noise cost when a slug happens to be one is worth not
# maintaining a keyword list.
_SAFE_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _parse_json_string(v: object) -> object:
    """Accept a JSON string or a dict for other_properties."""
    if isinstance(v, str):
        return json.loads(v)
    return v


def quote_ident(name: str) -> str:
    """Return `name` as a SQL identifier, quoted only when necessary.

    Embedded double quotes are escaped by doubling. Used by `TableRef.fqn`
    and `tables.org_fqn` to keep generated SQL readable when
    slugs are plain (`default`, `acme`) and still safe when they aren't
    (`nyc-dsa`).
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
        unquoted but `nyc-dsa` becomes `"nyc-dsa"`).
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
    """A person to be canvassed. This is the canonical output schema
    that every voter file transformation query must produce."""

    external_id: str
    external_id_type: str

    first_name: str
    last_name: str

    # Address fields
    address_line_1: str
    address_line_2: str | None = None
    city: str
    state: str
    zip5: str
    zip4: str | None = None

    other_properties: Annotated[dict[str, str | None], BeforeValidator(_parse_json_string)] = {}
