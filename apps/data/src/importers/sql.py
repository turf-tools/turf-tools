"""SQL fragments importer transforms build from."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

    from src.importers.base import ImportFilter


def case_from_map(col: str, mapping: Mapping[str, str], default: str | None = None) -> str:
    """SQL CASE mapping `col`'s values via `mapping`; unmatched non-NULL values
    get `default` (None → NULL). NULL stays NULL."""
    branches = " ".join(f"WHEN {col} = '{raw}' THEN '{label}'" for raw, label in mapping.items())
    else_clause = "NULL" if default is None else f"CASE WHEN {col} IS NULL THEN NULL ELSE '{default}' END"
    return f"CASE {branches} ELSE {else_clause} END"


def county_local_sql(col: str, county: str, *, county_first: bool = True) -> str:
    """A code that's only unique within its county, joined to the county with a
    hyphen: precinct `135` in Miami-Dade → `DAD-135`, or `135-DAD` without
    `county_first`, for a state that writes its own place-scoped codes code first."""
    joined = f"{county} || '-' || {col}" if county_first else f"{col} || '-' || {county}"
    return f"CASE WHEN {col} IS NULL THEN NULL ELSE {joined} END"


def filter_predicate(filter: ImportFilter | None, expressions: Mapping[str, str] | None = None) -> str | None:
    """The condition over the raw table (aliased `raw`) that keeps the rows
    `filter` selects, or None without one. `expressions` stands in for a column
    the filter compares in another form (`left(raw.residence_zipcode, 5)`)."""
    if not filter or not filter.values:
        return None
    joined = ", ".join("'" + v.replace("'", "''") + "'" for v in filter.values)
    expression = (expressions or {}).get(filter.column, f"raw.{filter.column}")
    return f"{expression} IN ({joined})"


def where_sql(filter: ImportFilter | None, expressions: Mapping[str, str] | None = None) -> str:
    """`filter_predicate` as a WHERE clause, or "" without a filter."""
    predicate = filter_predicate(filter, expressions)
    return f"WHERE {predicate}" if predicate else ""
