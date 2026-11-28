"""Read a CSV with a header row, or a parquet, whose columns carry a layout's
field names into a raw table.

Columns are matched to the layout by `raw_column_name`, so case and spacing
don't matter. Values get the same trim and blank-to-NULL as a raw decode;
layout fields the source leaves out load as NULL, and columns outside the layout
are ignored. A parquet that stores a zero-padded code as a number gets its zeros
back.
"""

from __future__ import annotations

import codecs
import csv
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

import duckdb
from src.importers.base import SourceUnreadableError, raw_column_name
from src.importers.streams import TRIM_CHARS, first_line, sql_str
from src.models import quote_ident

if TYPE_CHECKING:
    from collections.abc import Mapping

TabularFormat = Literal["csv", "parquet"]

_NUMERIC_TYPES = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT")
_FRACTIONAL_TYPES = ("FLOAT", "DOUBLE", "DECIMAL")


@dataclass(frozen=True)
class Layout:
    """A source's field list, as the state spells it, in source order."""

    # Names messages use for the layout ("NYSVOTER layout") and a few of its
    # fields ("LASTNAME, FIRSTNAME, … SBOEID").
    name: str
    examples: str
    fields: list[str]
    # Raw column names the transform reads; the rest of the layout is optional.
    required: frozenset[str]
    # Raw column name → width, for codes that are fixed-width with leading zeros.
    zero_padded: Mapping[str, int] = field(default_factory=dict)

    @property
    def columns(self) -> list[str]:
        return [raw_column_name(f) for f in self.fields]


def csv_has_header(source: str, layout: Layout) -> bool:
    """Whether a CSV's first row is the layout's field names rather than a record.

    A header matches on most of its fields; a voter's name and address match on
    none, short of a coincidence like a surname of `Ward`."""
    first = first_line(source).removeprefix(codecs.BOM_UTF8).decode("latin-1")
    fields = next(csv.reader([first]), [])
    columns = set(layout.columns)
    matched = sum(1 for f in fields if raw_column_name(f) in columns)
    return matched > 0 and matched * 2 >= len(fields)


def load_tabular_to_table(
    source: str,
    fmt: TabularFormat,
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
    layout: Layout,
    where: str = "",
) -> None:
    """Read a CSV-with-header (UTF-8 or Latin-1) or parquet into `table_fqn` as
    the layout's columns, then `where` over them."""
    if fmt == "parquet":
        _load(f"read_parquet({sql_str(source)})", table_fqn, conn, layout, where)
        return
    # A state's own export may be Latin-1; a re-saved CSV may be either.
    for encoding in ("utf-8", "latin-1"):
        reader = f"read_csv({sql_str(source)}, header=true, all_varchar=true, encoding={sql_str(encoding)})"
        try:
            _load(reader, table_fqn, conn, layout, where)
            return
        except duckdb.InvalidInputException as exc:
            if encoding != "utf-8" or "not utf-8 encoded" not in str(exc):
                raise


def _text_sql(column: str, source_column: str, source_type: str, layout: Layout) -> str:
    """SQL reading `source_column` as the layout's text. Numbers read as their
    digits (`3.0` → `3`), and a zero-padded code gets its zeros back."""
    ident = quote_ident(source_column)
    if source_type.startswith(_NUMERIC_TYPES):
        text = f"CAST({ident} AS VARCHAR)"
    elif source_type.startswith(_FRACTIONAL_TYPES):
        text = (
            f"CASE WHEN {ident} = trunc({ident}) THEN CAST(CAST({ident} AS HUGEINT) AS VARCHAR) "
            f"ELSE CAST({ident} AS VARCHAR) END"
        )
    else:
        return f"CAST({ident} AS VARCHAR)"
    width = layout.zero_padded.get(column)
    return f"lpad({text}, {width}, '0')" if width else text


def _load(reader: str, table_fqn: str, conn: duckdb.DuckDBPyConnection, layout: Layout, where: str) -> None:
    described = conn.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
    source_columns = [row[0] for row in described]
    source_types = {row[0]: row[1] for row in described}
    columns = layout.columns

    # DuckDB suffixes a case-variant duplicate (`rzip5_1`), so names are unique
    # here and a duplicate simply doesn't match.
    layout_columns = set(columns)
    source_by_column = {raw_column_name(c): c for c in source_columns if raw_column_name(c) in layout_columns}

    if not source_by_column:
        raise SourceUnreadableError(
            f"None of the file's columns match the {layout.name} field names ({layout.examples}). "
            "Name the columns after the layout's fields; case doesn't matter."
        )
    missing = [
        name
        for name, column in zip(layout.fields, columns, strict=True)
        if column in layout.required and column not in source_by_column
    ]
    if missing:
        raise SourceUnreadableError(
            f"The file is missing {layout.name} fields: {', '.join(missing)}. "
            "Name the columns after the layout's fields; case doesn't matter."
        )

    trim_set = sql_str(TRIM_CHARS)
    projections = ",\n    ".join(
        f"NULLIF(trim({_text_sql(column, source_by_column[column], source_types[source_by_column[column]], layout)}, "
        f"{trim_set}), '') AS {column}"
        if column in source_by_column
        else f"CAST(NULL AS VARCHAR) AS {column}"
        for column in columns
    )
    select = f"SELECT\n    {projections}\nFROM {reader}"
    conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} AS SELECT * FROM ({select}) {where}")
