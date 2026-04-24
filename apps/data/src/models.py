"""Shared data models for Hamilton graph nodes."""

import json
from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, BeforeValidator


def _parse_json_string(v: object) -> object:
    """Accept a JSON string or a dict for other_properties."""
    if isinstance(v, str):
        return json.loads(v)
    return v


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
        """Fully qualified table name: catalog.schema.table."""
        return f"{self.catalog}.{self.schema}.{self.table}"


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
