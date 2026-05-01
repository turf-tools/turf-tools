"""Compile criteria DSL → DuckDB WHERE fragment + params.

Used by the typed query endpoints (`/persons/count`, `/persons/by-key`,
`/buildings/count`, `/buildings/points`) and by `/turfs/build` to assemble
the persons-side filter portion of their SQL.

User values flow through `params` (DuckDB `?` bind), never through
string interpolation. Field metadata from the catalog (column names,
JSONB keys) is the only thing that lands directly in the SQL string.
"""

from typing import Any

from .criteria import (
    FIELDS,
    KEY_GROUPS,
    AgeRangeFieldDef,
    AgeRangeFilter,
    Criteria,
    EnumFieldDef,
    EnumFilter,
    FieldDef,
    KeyFilter,
    TextFieldDef,
    TextFilter,
)


class CriteriaError(ValueError):
    """Invalid criteria — unknown field, kind/field-def mismatch, etc."""


def to_where(
    criteria: Criteria,
    key_filter: KeyFilter | None = None,
) -> tuple[str, list[Any]]:
    """Compile a `Criteria` (and optional spatial scope) into a WHERE
    fragment + bind params.

    Returns `("WHERE ...", [...])` when there's at least one constraint,
    or `("", [])` for empty criteria with no key filter — callers compose
    accordingly.
    """
    clauses: list[str] = []
    params: list[Any] = []
    for f in criteria.filters:
        clause = _filter_clause(f, params)
        if clause:
            clauses.append(clause)
    if key_filter is not None:
        clause = _key_filter_clause(key_filter, params)
        if clause:
            clauses.append(clause)
    if not clauses:
        return "", []
    return f"WHERE {' AND '.join(clauses)}", params


def column_expr_for(field_key: str) -> str:
    """SQL expression for a field. Top-level columns are bare names;
    other_properties extracts use `->>`.
    """
    field_def = FIELDS.get(field_key)
    if field_def is None:
        raise CriteriaError(f"Unknown field: {field_key}")
    return _column_expr(field_key, field_def.source)


def boundary_key_expr_for(key_group: str) -> str:
    """SQL expression producing each person's boundary key for the given
    keyGroup. Used as the GROUP BY target in per-key aggregation
    (`/persons/by-key`).
    """
    field_key = KEY_GROUPS.get(key_group)
    if field_key is None:
        raise CriteriaError(f"Unknown keyGroup: {key_group}")
    return column_expr_for(field_key)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _column_expr(key: str, source: str) -> str:
    if source == "column":
        return key
    # other_properties JSONB extract — parenthesized to dodge DuckDB's
    # precedence trap where `->>` binds looser than `IN/=/ILIKE`. Without
    # the parens, `other_properties->>'gender' IN (?)` would parse as
    # `other_properties->>('gender' IN (?))`.
    return f"(other_properties->>'{key}')"


def _filter_clause(f: EnumFilter | AgeRangeFilter | TextFilter, params: list) -> str:
    field_def = FIELDS.get(f.key)
    if field_def is None:
        raise CriteriaError(f"Unknown field: {f.key}")
    if isinstance(f, EnumFilter):
        return _enum_clause(f, field_def, params)
    if isinstance(f, AgeRangeFilter):
        return _age_range_clause(f, field_def, params)
    if isinstance(f, TextFilter):
        return _text_clause(f, field_def, params)
    raise CriteriaError(f"Unknown filter kind: {type(f).__name__}")


def _enum_clause(f: EnumFilter, def_: FieldDef, params: list) -> str:
    if not isinstance(def_, EnumFieldDef):
        raise CriteriaError(f"Field {f.key} is not an enum field")
    if not f.values:
        return ""
    expr = _column_expr(f.key, def_.source)
    placeholders = ", ".join("?" for _ in f.values)
    params.extend(f.values)
    return f"{expr} IN ({placeholders})"


def _age_range_clause(f: AgeRangeFilter, def_: FieldDef, params: list) -> str:
    if not isinstance(def_, AgeRangeFieldDef):
        raise CriteriaError(f"Field {f.key} is not an age-range field")
    if f.min is None and f.max is None:
        return ""
    expr = _column_expr(f.key, def_.source)
    # SBOE date_of_birth lands as compact YYYYMMDD ("19670628").
    # try_strptime returns NULL for malformed inputs, which makes the
    # age comparison false → row drops out of the result.
    dob = f"try_strptime({expr}, '%Y%m%d')::DATE"
    age_years = f"extract(year from age(current_date, {dob}))"
    parts: list[str] = []
    if f.min is not None:
        parts.append(f"{age_years} >= ?")
        params.append(f.min)
    if f.max is not None:
        parts.append(f"{age_years} <= ?")
        params.append(f.max)
    return f"({' AND '.join(parts)})"


def _text_clause(f: TextFilter, def_: FieldDef, params: list) -> str:
    if not isinstance(def_, TextFieldDef):
        raise CriteriaError(f"Field {f.key} is not a text field")
    if not f.value.strip():
        return ""
    expr = _column_expr(f.key, def_.source)
    if def_.op == "equals":
        params.append(f.value)
        return f"{expr} = ?"
    params.append(f"%{f.value}%")
    return f"{expr} ILIKE ?"


def _key_filter_clause(kf: KeyFilter, params: list) -> str:
    if not kf.keys:
        # Match nothing rather than emit an invalid `IN ()`.
        return "1=0"
    expr = boundary_key_expr_for(kf.keyGroup)
    placeholders = ", ".join("?" for _ in kf.keys)
    params.extend(kf.keys)
    return f"{expr} IN ({placeholders})"
