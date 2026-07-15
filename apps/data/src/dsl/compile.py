"""Compile criteria DSL → DuckDB WHERE fragment + params.

Used by the typed query endpoints (`/persons/count`, `/persons/by-key`,
`/buildings/count`, `/buildings/points`) and by `/turfs/build` to assemble
the persons-side filter portion of their SQL.

User values flow through `params` (DuckDB `?` bind), never through
string interpolation. Field metadata from the catalog (column names) is
the only thing that lands directly in the SQL string.
"""

from typing import Any

from .criteria import (
    AddressFieldDef,
    AddressFilter,
    AgeRangeFieldDef,
    AgeRangeFilter,
    AllFilter,
    CanvassOutcomeFilter,
    CanvassResponseFilter,
    Criteria,
    DateRangeFieldDef,
    DateRangeFilter,
    EnumFieldDef,
    EnumFilter,
    FieldCatalog,
    FieldDef,
    Filter,
    KeyFilter,
    NestedFilter,
    PersonIdSetFilter,
    TextFieldDef,
    TextFilter,
    TextMultiFieldDef,
    TextMultiFilter,
    VotingHistoryFieldDef,
    VotingHistoryFilter,
)


class CriteriaError(ValueError):
    """Invalid criteria — unknown field, kind/field-def mismatch, etc."""


def criteria_to_where(
    catalog: FieldCatalog,
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
    expr = _criteria_bool_expr(catalog, criteria, params)
    clauses = [c for c in [expr, _key_filter_clause(catalog, key_filter, params) if key_filter else ""] if c]
    if not clauses:
        return ""
    return f"WHERE {' AND '.join(clauses)}"


def cascade_sql(catalog: FieldCatalog, criteria: Criteria, persons_table: str, params: list[Any]) -> str:
    """Build a single SQL query returning N+1 waterfall counts in one scan.

    Emits ``COUNT(*) FILTER (WHERE expr_i)`` per prefix so each row is
    visited once and tested against every step's expression. Params are
    appended in source order so the ``?`` placeholders line up.
    """
    selects = ["count(*) AS step_0"]
    for i in range(1, len(criteria.steps) + 1):
        prefix = Criteria(steps=criteria.steps[:i])
        prefix_params: list[Any] = []
        expr = _criteria_bool_expr(catalog, prefix, prefix_params)
        params.extend(prefix_params)
        if expr:
            selects.append(f"count(*) FILTER (WHERE {expr}) AS step_{i}")
        else:
            selects.append(f"count(*) AS step_{i}")
    return f"SELECT {', '.join(selects)} FROM {persons_table}"


def column_expr_for(catalog: FieldCatalog, field_key: str) -> str:
    """SQL expression for a field — every field is a bare top-level column."""
    if field_key not in catalog.fields:
        raise CriteriaError(f"Unknown field: {field_key}")
    return field_key


def boundary_key_expr_for(catalog: FieldCatalog, key_group: str) -> str:
    """SQL expression producing each person's boundary key for the given
    keyGroup. Used as the GROUP BY target in per-key aggregation.
    """
    field_key = catalog.key_groups.get(key_group)
    if field_key is None:
        raise CriteriaError(f"Unknown keyGroup: {key_group}")
    return column_expr_for(catalog, field_key)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _criteria_bool_expr(catalog: FieldCatalog, criteria: Criteria, params: list[Any]) -> str:
    """Reduce criteria to a Boolean SQL expression string.

    Returns ``""`` for empty / fully-inactive criteria (match all).
    """
    current: str | None = None  # None = True (full universe)

    for step in criteria.steps:
        fc = _filter_clause(catalog, step.filter, params)
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


def _field(catalog: FieldCatalog, key: str) -> FieldDef:
    field_def = catalog.fields.get(key)
    if field_def is None:
        raise CriteriaError(f"Unknown field: {key}")
    return field_def


def _filter_clause(catalog: FieldCatalog, f: Filter, params: list[Any]) -> str:
    if isinstance(f, AllFilter):
        return "1=1"
    if isinstance(f, EnumFilter):
        return _enum_clause(f, _field(catalog, f.key), params)
    if isinstance(f, AgeRangeFilter):
        return _age_range_clause(f, _field(catalog, f.key), params)
    if isinstance(f, TextFilter):
        return _text_clause(f, _field(catalog, f.key), params)
    if isinstance(f, TextMultiFilter):
        return _text_multi_clause(f, _field(catalog, f.key), params)
    if isinstance(f, DateRangeFilter):
        return _date_range_clause(f, _field(catalog, f.key), params)
    if isinstance(f, VotingHistoryFilter):
        return _voting_history_clause(f, _field(catalog, f.key), params)
    if isinstance(f, AddressFilter):
        return _address_clause(f, _field(catalog, f.key), params)
    if isinstance(f, NestedFilter):
        # Empty inner → 1=1 to match the standalone "empty segment matches everyone" semantic.
        inner = _criteria_bool_expr(catalog, f.criteria, params)
        return f"({inner})" if inner else "1=1"
    if isinstance(f, PersonIdSetFilter):
        # Resolved canvass / operational-data filter: a literal person set.
        # Empty set → 1=0 (no one matched), distinct from an inactive filter.
        if not f.ids:
            return "1=0"
        placeholders = ", ".join("?" for _ in f.ids)
        params.extend(f.ids)
        return f"external_id IN ({placeholders})"
    if isinstance(f, (CanvassOutcomeFilter, CanvassResponseFilter)):
        # Should have been reduced to a PersonIdSetFilter in resolve.py.
        raise CriteriaError(f"{type(f).__name__} reached the compiler unresolved")
    raise CriteriaError(f"Unknown filter kind: {type(f).__name__}")


def _enum_clause(f: EnumFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, EnumFieldDef):
        raise CriteriaError(f"Field {f.key} is not an enum field")
    if not f.values:
        return ""
    expr = f.key
    placeholders = ", ".join("?" for _ in f.values)
    params.extend(f.values)
    return f"{expr} IN ({placeholders})"


def _age_range_clause(f: AgeRangeFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, AgeRangeFieldDef):
        raise CriteriaError(f"Field {f.key} is not an age-range field")
    if f.min is None and f.max is None:
        return ""
    expr = f.key
    dob = f"try_strptime({expr}, '%Y-%m-%d')::DATE"
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
    expr = f.key
    if def_.op == "equals":
        params.append(f.value)
        return f"{expr} = ?"
    params.append(f"%{f.value}%")
    return f"{expr} ILIKE ?"


def _text_multi_clause(f: TextMultiFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, TextMultiFieldDef):
        raise CriteriaError(f"Field {f.key} is not a text-multi field")
    vals = [v.strip() for v in f.values if v.strip()]
    if not vals:
        return ""
    expr = f.key
    placeholders = ", ".join("?" for _ in vals)
    params.extend(vals)
    return f"{expr} IN ({placeholders})"


def _date_range_clause(f: DateRangeFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, DateRangeFieldDef):
        raise CriteriaError(f"Field {f.key} is not a date-range field")
    if not f.min and not f.max:
        return ""
    expr = f.key
    parts: list[str] = []
    if f.min:
        parts.append(f"{expr} >= ?")
        params.append(f.min)
    if f.max:
        parts.append(f"{expr} <= ?")
        params.append(f.max)
    return f"({' AND '.join(parts)})"


# Maps the filter's `type` choice to the canonical voting_history.type values
# it covers. "primary" merges presidential primaries with regular primaries
# (the common targeting meaning).
_VH_TYPE_GROUPS: dict[str, tuple[str, ...]] = {
    "primary": ("primary", "presidential_primary"),
    "general": ("general",),
}


def _address_clause(f: AddressFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, AddressFieldDef):
        raise CriteriaError(f"Field {f.key} is not an address field")
    parts: list[str] = []
    if f.line1.strip():
        parts.append("address_line_1 ILIKE ?")
        params.append(f"%{f.line1.strip()}%")
    if f.city.strip():
        parts.append("city ILIKE ?")
        params.append(f"%{f.city.strip()}%")
    if f.state.strip():
        parts.append("state = ?")
        params.append(f.state.strip().upper())
    if f.zip.strip():
        parts.append("zip5 = ?")
        params.append(f.zip.strip())
    if not parts:
        return ""
    return "(" + " AND ".join(parts) + ")"


def _voting_history_clause(f: VotingHistoryFilter, def_: FieldDef, params: list[Any]) -> str:
    if not isinstance(def_, VotingHistoryFieldDef):
        raise CriteriaError(f"Field {f.key} is not a voting-history-count field")
    if f.window_years <= 0 or f.count < 0:
        return ""
    types = _VH_TYPE_GROUPS[f.type]
    type_placeholders = ", ".join("?" for _ in types)
    # list_filter + len keeps this a scalar expression (no correlated subquery).
    # `year(current_date) - ?` keeps the recency window relative to query time.
    inner = f"len(list_filter({def_.key}, e -> e.year >= year(current_date) - ? AND e.type IN ({type_placeholders})))"
    params.append(f.window_years)
    params.extend(types)
    op = ">=" if f.comparator == "at_least" else "="
    params.append(f.count)
    return f"{inner} {op} ?"


def _key_filter_clause(catalog: FieldCatalog, kf: KeyFilter, params: list[Any]) -> str:
    if not kf.keys:
        return "1=0"
    expr = boundary_key_expr_for(catalog, kf.key_group)
    placeholders = ", ".join("?" for _ in kf.keys)
    params.extend(kf.keys)
    return f"{expr} IN ({placeholders})"
