"""SQL for segment exports: one row per person, or one per household (door).

People columns are the core `EXPORT_COLUMNS` plus the dataset's own manifest
fields, limited to what the version's `persons_geocoded` actually has.
Household columns describe the door, with a household name and head count in
place of per-person fields. Names export in capitals, like the addresses, so
every voter file's export reads the same (USPS prefers capitals on every line
of an address block). The returned SQL names `{persons_geocoded}`; the caller
resolves it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from src.models import EXPORT_COLUMNS, EXPORT_OPTIONAL, EXPORT_ROUNDED, export_select_list

if TYPE_CHECKING:
    from src.importers.base import Manifest

Rows = Literal["people", "households"]

# Manifest kinds whose column isn't a single value per person.
_LIST_KINDS = {"voting-history-count", "voting-history-detail"}

HOUSEHOLD_COLUMNS = [
    "household_name",
    "person_count",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "zip5",
    "latitude",
    "longitude",
]

NAME_COLUMNS = ("first_name", "middle_name", "last_name", "name_suffix")

# xlsx caps a sheet at 1,048,576 rows, one of which is the header.
EXCEL_MAX_ROWS = 1_048_575


class ExportColumnError(ValueError):
    """A requested column isn't exportable for this version and row type."""


def people_columns(manifest: Manifest, persons_columns: set[str]) -> list[str]:
    """Exportable person columns, core first, each present in the table."""
    columns = [c for c in EXPORT_COLUMNS if c in persons_columns]
    for section in manifest.fields:
        for fd in section:
            if fd.column and fd.filter_kind not in _LIST_KINDS and fd.column not in columns:
                columns.append(fd.column)
    return [c for c in columns if c in persons_columns]


def household_columns(persons_columns: set[str]) -> list[str]:
    """Exportable household columns, each backed by the table."""
    return [c for c in HOUSEHOLD_COLUMNS if c != "address_line_2" or c in persons_columns]


def export_sql(
    rows: Rows,
    columns: list[str] | None,
    where: str,
    manifest: Manifest,
    persons_columns: set[str],
) -> str:
    """SELECT for an export of `columns` (the row type's defaults when None).
    Optional core columns the version lacks are dropped rather than rejected:
    the caller can't tell which of them a dataset has."""
    allowed = people_columns(manifest, persons_columns) if rows == "people" else household_columns(persons_columns)
    if columns is None:
        columns = [c for c in EXPORT_COLUMNS if c in allowed] if rows == "people" else allowed
    columns = [c for c in columns if c in persons_columns or c not in EXPORT_OPTIONAL]
    unknown = [c for c in columns if c not in allowed]
    if unknown or not columns:
        raise ExportColumnError(f"Can't export {unknown or 'no columns'} as {rows}.")
    if rows == "people":
        select = ", ".join(f"upper({c}) AS {c}" if c in NAME_COLUMNS else export_select_list([c]) for c in columns)
        return f"SELECT {select} FROM {{persons_geocoded}} {where}"
    return _households_sql(columns, where, persons_columns)


def _households_sql(columns: list[str], where: str, persons_columns: set[str]) -> str:
    name_parts = [c for c in NAME_COLUMNS if c in persons_columns]
    full_name = f"concat_ws(' ', {', '.join(name_parts)})"
    # Capitals before grouping, so "Smith" and "SMITH" at one door are one family.
    upper_names = ", ".join(f"upper({c}) AS {c}" for c in name_parts)
    exprs = {
        "household_name": """CASE
            WHEN count(*) = 1 THEN min(full_name)
            WHEN count(DISTINCT last_name) = 1 AND count(*) = 2
                THEN string_agg(first_name, ' & ' ORDER BY first_name) || ' ' || min(last_name)
            WHEN count(DISTINCT last_name) = 1 THEN 'THE ' || min(last_name) || ' FAMILY'
            WHEN count(*) = 2 THEN string_agg(full_name, ' & ' ORDER BY full_name)
            ELSE 'OUR FRIENDS AT'
        END""",
        "person_count": "count(*)",
        "address_line_1": "min(address_line_1)",
        "address_line_2": "min(address_line_2)",
        "city": "min(city)",
        "state": "min(state)",
        # door_id ends with the building's ZIP, the one its ids are built from.
        "zip5": "split_part(min(door_id), '|', 3)",
        **{c: f"round(avg({c}), {EXPORT_ROUNDED[c]})" for c in ("latitude", "longitude")},
    }
    select = ", ".join(f"{exprs[c]} AS {c}" for c in columns)
    return (
        f"SELECT {select} "
        f"FROM (SELECT *, {full_name} AS full_name "
        f"FROM (SELECT * REPLACE ({upper_names}) FROM {{persons_geocoded}} {where})) "
        f"GROUP BY door_i ORDER BY min(door_id)"
    )
