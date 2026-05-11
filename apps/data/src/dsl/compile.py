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
    AllFilter,
    Criteria,
    EnumFieldDef,
    EnumFilter,
    FieldDef,
    Filter,
    KeyFilter,
    TextFieldDef,
    TextFilter,
)


class CriteriaError(ValueError):
    """Invalid criteria — unknown field, kind/field-def mismatch, etc."""


def criteria_to_where(
    criteria: Criteria,
    key_filter: KeyFilter | None,
    params: list[Any],
) -> str:
    """Compile a ``Criteria`` to a WHERE fragment using Boolean algebra.

    Each verb maps directly to a Boolean operator over the running expression:

    - ``narrow`` → AND (intersection)
    - ``add``    → OR  (union)
    - ``remove`` → AND NOT (difference)

    This produces a single flat predicate — no subqueries, no CTEs, no extra
    column reads. The resulting WHERE clause is semantically equivalent to the
    sequential set operations and lets DuckDB apply its normal predicate
    pushdown and column-pruning optimisations.

    Params are appended in-place. Returns ``""`` (no WHERE) for empty
    criteria with no key_filter.
    """
    expr = _criteria_bool_expr(criteria, params)
    clauses = [c for c in [expr, _key_filter_clause(key_filter, params) if key_filter else ""] if c]
    if not clauses:
        return ""
    return f"WHERE {' AND '.join(clauses)}"


def cascade_sql(criteria: Criteria, persons_table: str, params: list[Any]) -> str:
    """Build a single SQL query returning N+1 waterfall counts in one scan.

    Emits ``COUNT(*) FILTER (WHERE expr_i)`` per prefix so each row is
    visited once and tested against every step's expression. Params are
    appended in source order so the ``?`` placeholders line up.
    """
    selects = ["count(*) AS step_0"]
    for i in range(1, len(criteria.steps) + 1):
        prefix = Criteria(steps=criteria.steps[:i])
        prefix_params: list[Any] = []
        expr = _criteria_bool_expr(prefix, prefix_params)
        params.extend(prefix_params)
        if expr:
            selects.append(f"count(*) FILTER (WHERE {expr}) AS step_{i}")
        else:
            selects.append(f"count(*) AS step_{i}")
    return f"SELECT {', '.join(selects)} FROM {persons_table}"


def column_expr_for(field_key: str) -> str:
    """SQL expression for a field. Top-level columns are bare names;
    other_properties extracts use ``->>``.
    """
    field_def = FIELDS.get(field_key)
    if field_def is None:
        raise CriteriaError(f"Unknown field: {field_key}")
    return _column_expr(field_key, field_def.source)


def boundary_key_expr_for(key_group: str) -> str:
    """SQL expression producing each person's boundary key for the given
    keyGroup. Used as the GROUP BY target in per-key aggregation.
    """
    field_key = KEY_GROUPS.get(key_group)
    if field_key is None:
        raise CriteriaError(f"Unknown keyGroup: {key_group}")
    return column_expr_for(field_key)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _criteria_bool_expr(criteria: Criteria, params: list[Any]) -> str:
    """Reduce criteria to a Boolean SQL expression string.

    Returns ``""`` for empty / fully-inactive criteria (match all).
    """
    current: str | None = None  # None = True (full universe)

    for step in criteria.steps:
        fc = _filter_clause(step.filter, params)
        if not fc:
            # Inactive filter (empty enum values, unbounded age range, etc.)
            # has no effect on the set regardless of verb.
            continue

        if current is None:
            current = fc if step.verb in ("narrow", "add") else f"NOT ({fc})"
        else:
            if step.verb == "narrow":
                current = f"({current}) AND ({fc})"
            elif step.verb == "add":
                current = f"({current}) OR ({fc})"
            else:  # remove
                current = f"({current}) AND NOT ({fc})"

    return current or ""


def _column_expr(key: str, source: str) -> str:
    if source == "column":
        return key
    # other_properties JSONB extract — parenthesized to dodge DuckDB's
    # precedence trap where ``->>`` binds looser than ``IN/=/ILIKE``.
    return f"(other_properties->>'{key}')"


def _filter_clause(f: Filter, params: list[Any]) -> str:
    if isinstance(f, AllFilter):
        return "1=1"
    if isinstance(f, EnumFilter):
        field_def = FIELDS.get(f.key)
        if field_def is None:
            raise CriteriaError(f"Unknown field: {f.key}")
        return _enum_clause(f, field_def, params)
    if isinstance(f, AgeRangeFilter):
        field_def = FIELDS.get(f.key)
        if field_def is None:
            raise CriteriaError(f"Unknown field: {f.key}")
        return _age_range_clause(f, field_def, params)
    if isinstance(f, TextFilter):
        field_def = FIELDS.get(f.key)
        if field_def is None:
            raise CriteriaError(f"Unknown field: {f.key}")
        return _text_clause(f, field_def, params)
    raise CriteriaError(f"Unknown filter kind: {type(f).__name__}")


def _enum_clause(f: EnumFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, EnumFieldDef):
        raise CriteriaError(f"Field {f.key} is not an enum field")
    if not f.values:
        return ""
    expr = _column_expr(f.key, def_.source)
    placeholders = ", ".join("?" for _ in f.values)
    params.extend(f.values)
    return f"{expr} IN ({placeholders})"


def _age_range_clause(f: AgeRangeFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, AgeRangeFieldDef):
        raise CriteriaError(f"Field {f.key} is not an age-range field")
    if f.min is None and f.max is None:
        return ""
    expr = _column_expr(f.key, def_.source)
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


def _text_clause(f: TextFilter, def_: FieldDef, params: list[Any]) -> str:
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


def _key_filter_clause(kf: KeyFilter, params: list[Any]) -> str:
    if not kf.keys:
        return "1=0"
    expr = boundary_key_expr_for(kf.keyGroup)
    placeholders = ", ".join("?" for _ in kf.keys)
    params.extend(kf.keys)
    return f"{expr} IN ({placeholders})"
